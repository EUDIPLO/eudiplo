import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { PinoLogger } from "nestjs-pino";
import { Repository } from "typeorm";
import { RegistrarService } from "../../../registrar/registrar.service.js";
import {
    PresentationConfig,
    RegistrationCertCache,
} from "../entities/presentation-config.entity.js";
import {
    PRESENTATION_SETTINGS,
    type PresentationSettings,
} from "../presentation-settings.js";

type ResolvedRegistrationCertificate = Awaited<
    ReturnType<RegistrarService["resolveRegistrationCertificate"]>
>;

/** Seconds before `exp` at which a cached certificate is treated as expired. */
const CACHE_EXPIRY_SKEW_SECONDS = 60;

/**
 * Registration certificates for presentation configurations.
 *
 * The registrar-issued (or imported) certificate is cached on the
 * presentation config (`registrationCertCache`). The cache is valid while the
 * `registration_cert` spec and the `dcql_query` are unchanged and the JWT has
 * not expired.
 */
@Injectable()
export class PresentationRegistrationCertificateService {
    constructor(
        @InjectRepository(PresentationConfig)
        private readonly repository: Repository<PresentationConfig>,
        private readonly registrarService: RegistrarService,
        @Inject(PRESENTATION_SETTINGS)
        private readonly settings: PresentationSettings,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(PresentationRegistrationCertificateService.name);
    }

    /**
     * Resolve the registration-certificate JWT to attach to a VP request,
     * using the embedded {@link PresentationConfig.registrationCertCache}
     * when it is still valid. On a cache miss/expiry the cert is freshly
     * resolved via {@link RegistrarService} and the cache is persisted.
     *
     * Returns `undefined` when the config has no `registrationCert` spec or
     * the registrar is not enabled for this tenant.
     */
    async getOrIssueRegistrationCertificate(
        presentationConfig: PresentationConfig,
        resolvedDcqlQuery: any,
        requestId: string,
    ): Promise<string | undefined> {
        if (!presentationConfig.registration_cert) {
            return undefined;
        }
        if (
            !(await this.registrarService.isEnabledForTenant(
                presentationConfig.tenantId,
            ))
        ) {
            return undefined;
        }

        const dcqlFingerprint = this.registrarService.computeDcqlFingerprint(
            presentationConfig.dcql_query,
        );
        const specFingerprint = this.registrarService.computeSpecFingerprint(
            presentationConfig.registration_cert,
        );

        const cache = presentationConfig.registrationCertCache;
        if (isCacheValid(cache, dcqlFingerprint, specFingerprint)) {
            return cache.jwt;
        }

        const resolved =
            await this.registrarService.resolveRegistrationCertificate(
                presentationConfig.registration_cert as any,
                resolvedDcqlQuery,
                requestId,
                presentationConfig.tenantId,
                {
                    accessKeyChainId:
                        presentationConfig.accessKeyChainId ?? undefined,
                },
            );

        const newCache = this.toCache(
            resolved,
            dcqlFingerprint,
            specFingerprint,
        );

        await this.repository.update(
            {
                id: presentationConfig.id,
                tenantId: presentationConfig.tenantId,
            },
            { registrationCertCache: newCache },
        );
        presentationConfig.registrationCertCache = newCache;

        return resolved.jwt;
    }

    /**
     * Force-reissue the registration certificate of an already loaded
     * presentation config, bypassing the cache.
     *
     * Throws if the config has no `registrationCert` spec, the registrar is
     * not enabled for this tenant, or no certificate could be resolved.
     */
    async reissue(presentationConfig: PresentationConfig): Promise<void> {
        const { id, tenantId } = presentationConfig;
        if (!presentationConfig.registration_cert) {
            throw new BadRequestException(
                "Presentation config has no registrationCert spec",
            );
        }
        if (!(await this.registrarService.isEnabledForTenant(tenantId))) {
            throw new BadRequestException(
                "Registrar is not enabled for this tenant",
            );
        }

        // Resolve `<TENANT_URL>` placeholders so registrar validation/issuance
        // sees the same DCQL the runtime path will see.
        const resolvedDcql = this.resolveTenantUrl(
            presentationConfig.dcql_query,
            tenantId,
        );

        // Force a fresh resolve by clearing the cache first.
        presentationConfig.registrationCertCache = null;
        const reissueConfig = {
            ...presentationConfig,
            registration_cert: presentationConfig.registration_cert?.body
                ? {
                      body: presentationConfig.registration_cert.body,
                      ...(presentationConfig.registration_cert.id
                          ? { id: presentationConfig.registration_cert.id }
                          : {}),
                  }
                : presentationConfig.registration_cert,
        } as PresentationConfig;
        const jwt = await this.getOrIssueRegistrationCertificate(
            reissueConfig,
            resolvedDcql,
            `reissue-${id}`,
        );
        if (!jwt) {
            throw new BadRequestException(
                "Failed to reissue registration certificate",
            );
        }
    }

    /**
     * Trigger registration-certificate cache refresh in the background.
     * This keeps create/update endpoints responsive while cert issuance
     * happens asynchronously.
     */
    scheduleRefresh(id: string, tenantId: string): void {
        void this.refreshAsync(id, tenantId);
    }

    private async refreshAsync(id: string, tenantId: string): Promise<void> {
        try {
            const latest = await this.repository.findOneBy({
                id,
                tenantId,
            });

            if (!latest || !latest.registration_cert) {
                return;
            }

            const refreshed = {
                ...latest,
            } as PresentationConfig;

            await this.refreshCache(refreshed, latest);
            await this.repository.save(refreshed);
        } catch (err) {
            this.logger.warn(
                { err, tenantId, configId: id },
                "Asynchronous registration-certificate cache refresh failed; runtime will retry",
            );
        }
    }

    /**
     * Recompute (or invalidate) the embedded registration-certificate cache on
     * the about-to-be-saved presentation config.
     *
     * Behavior:
     *  - If `registrationCert` is unset → clears any stale cache.
     *  - If a cache exists for an unchanged `registrationCert` spec, unchanged
     *    `dcql_query`, and is not expired → keeps the existing cache.
     *  - Otherwise eagerly resolves the certificate via {@link RegistrarService}
     *    and stores the new cache. On registrar/network failure the cache is
     *    cleared and the save proceeds; the runtime path will retry.
     *
     * Errors raised by the registrar that indicate user-config problems
     * (`BadRequestException`) propagate to fail the save.
     */
    private async refreshCache(
        next: PresentationConfig,
        existing: PresentationConfig | undefined,
    ): Promise<void> {
        const spec = next.registration_cert;
        if (!spec) {
            next.registrationCertCache = null;
            return;
        }

        const dcqlFingerprint = this.registrarService.computeDcqlFingerprint(
            next.dcql_query,
        );
        const specFingerprint =
            this.registrarService.computeSpecFingerprint(spec);

        const cache = existing?.registrationCertCache;
        if (isCacheValid(cache, dcqlFingerprint, specFingerprint)) {
            next.registrationCertCache = cache;
            return;
        }

        let resolvedDcql: any;
        try {
            resolvedDcql = this.resolveTenantUrl(
                next.dcql_query,
                next.tenantId,
            );
        } catch {
            // No PUBLIC_URL in this context — fall back to the templated form.
            resolvedDcql = next.dcql_query;
        }

        try {
            const resolved =
                await this.registrarService.resolveRegistrationCertificate(
                    spec as any,
                    resolvedDcql,
                    next.id ?? "presentation-config-save",
                    next.tenantId,
                    { accessKeyChainId: next.accessKeyChainId ?? undefined },
                );
            next.registrationCertCache = this.toCache(
                resolved,
                dcqlFingerprint,
                specFingerprint,
            );
        } catch (err) {
            if (err instanceof BadRequestException) {
                // User-config error — fail the save so the user sees the issue.
                throw err;
            }
            this.logger.warn(
                { err, tenantId: next.tenantId, configId: next.id },
                "Failed to eagerly resolve registration certificate at save time; cache cleared, runtime will retry",
            );
            next.registrationCertCache = null;
        }
    }

    /**
     * Resolve `<TENANT_URL>` placeholders so registrar validation/issuance
     * sees the same DCQL the runtime path will see.
     */
    private resolveTenantUrl(dcqlQuery: unknown, tenantId: string): any {
        const tenantHost = `${this.settings.publicUrl}/issuers/${tenantId}`;
        return JSON.parse(
            JSON.stringify(dcqlQuery).replaceAll("<TENANT_URL>", tenantHost),
        );
    }

    private toCache(
        resolved: ResolvedRegistrationCertificate,
        dcqlFingerprint: string,
        specFingerprint: string,
    ): RegistrationCertCache {
        const payload = resolved.payload;
        return {
            jwt: resolved.jwt,
            fingerprint:
                this.registrarService.computeAuthorizedCredentialsFingerprint(
                    payload.credentials,
                ),
            dcqlFingerprint,
            specFingerprint,
            issuedAt: typeof payload.iat === "number" ? payload.iat : undefined,
            expiresAt:
                typeof payload.exp === "number" ? payload.exp : undefined,
            source: resolved.source,
        };
    }
}

function isCacheValid(
    cache: RegistrationCertCache | null | undefined,
    dcqlFingerprint: string,
    specFingerprint: string,
): cache is RegistrationCertCache {
    const now = Math.floor(Date.now() / 1000);
    return (
        !!cache &&
        cache.dcqlFingerprint === dcqlFingerprint &&
        cache.specFingerprint === specFingerprint &&
        (typeof cache.expiresAt !== "number" ||
            cache.expiresAt - CACHE_EXPIRY_SKEW_SECONDS > now)
    );
}
