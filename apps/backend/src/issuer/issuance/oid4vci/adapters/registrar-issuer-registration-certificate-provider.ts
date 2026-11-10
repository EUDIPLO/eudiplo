import { Logger } from "@nestjs/common";
import { v4 } from "uuid";
import type { RegistrationCertificateCreation } from "../../../../registrar/generated/index.js";
import { issuerRegistrationCertificateBody } from "../../../../registrar/issuer-registration-certificate-request.js";
import type { RegistrarService } from "../../../../registrar/registrar.service.js";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import type { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import type { IssuerRegistrationCertificateLock } from "../../../configuration/issuance/issuer-registration-certificate-lock.js";
import {
    DEFAULT_REGISTRATION_CERTIFICATE_RENEWAL,
    deriveRegistrationCertificateMaterial,
    type IssuerRegistrationCertificateSettings,
    isJwtActive,
    NO_CREDENTIAL_TYPES_MESSAGE,
    registrationCertificateFingerprint,
    unlistedCredentialTypes,
    unlistedCredentialTypesMessage,
    usableCachedCertificate,
} from "../domain/issuer-registration-certificate.js";
import type { IssuerRegistrationCertificateProvider } from "../ports/issuer-registration-certificate-provider.js";

/**
 * Provides the issuer registration certificate: the configured JWT in import
 * mode, or a registrar-issued certificate in generate mode. Generated
 * certificates are cached in the issuance configuration by fingerprint; a
 * replaced certificate is revoked at the registrar. `renewal` decides whether a
 * changed fingerprint replaces an active cached certificate.
 *
 * A usable cached certificate is returned without waiting. Otherwise one
 * generation per tenant runs at a time under the shared lock, which
 * **Regenerate now** uses too, and callers that arrive while it runs share
 * its result instead of queueing their own registrar request.
 */
export class RegistrarIssuerRegistrationCertificateProvider
    implements IssuerRegistrationCertificateProvider
{
    private readonly logger = new Logger(
        RegistrarIssuerRegistrationCertificateProvider.name,
    );
    private readonly inFlight = new Map<string, Promise<string | undefined>>();

    constructor(
        private readonly registrar: RegistrarService,
        private readonly credentials: CredentialsService,
        private readonly issuance: IssuanceService,
        private readonly publicUrl: string,
        private readonly lock: IssuerRegistrationCertificateLock,
    ) {}

    async resolve(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): Promise<string | undefined> {
        try {
            return settings.mode === "import"
                ? this.imported(tenantId, settings)
                : await this.generated(tenantId, settings);
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Failed to resolve issuer registration certificate: ${error instanceof Error ? error.message : "unknown error"}`,
            );
            return undefined;
        }
    }

    private imported(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): string | undefined {
        if (!settings.jwt) {
            this.logger.warn(
                `[${tenantId}] registrationCertificate is enabled in import mode but no jwt is configured`,
            );
            return undefined;
        }
        if (!isJwtActive(settings.jwt)) {
            this.logger.warn(
                `[${tenantId}] configured registration certificate jwt is expired or not active`,
            );
            return undefined;
        }
        return settings.jwt;
    }

    private async generated(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ): Promise<string | undefined> {
        const { cached } = await this.current(tenantId, settings);
        if (cached) {
            return cached;
        }
        const running = this.inFlight.get(tenantId);
        if (running) {
            return running;
        }
        const run = this.lock.run(tenantId, () =>
            this.generate(tenantId, settings),
        );
        this.inFlight.set(tenantId, run);
        const release = () => {
            if (this.inFlight.get(tenantId) === run) {
                this.inFlight.delete(tenantId);
            }
        };
        run.then(release, release);
        return run;
    }

    /** The current material, its fingerprint and a usable cached certificate. */
    private async current(
        tenantId: string,
        settings: IssuerRegistrationCertificateSettings,
    ) {
        const material = deriveRegistrationCertificateMaterial(
            await this.credentials.getCredentialConfigsForTenant(tenantId),
            this.publicUrl,
            tenantId,
        );
        const fingerprint = registrationCertificateFingerprint(
            settings,
            material,
        );
        const cache = (await this.issuance.getIssuanceConfiguration(tenantId))
            .registrationCertificateCache;
        const cached = usableCachedCertificate(
            cache,
            fingerprint,
            settings.renewal ?? DEFAULT_REGISTRATION_CERTIFICATE_RENEWAL,
        );
        return { material, fingerprint, cache, cached };
    }

    private async generate(
        tenantId: string,
        callerSettings: IssuerRegistrationCertificateSettings,
    ): Promise<string | undefined> {
        // Read again under the lock: a previous run may have renewed the
        // certificate, and callers sharing this run may hold older settings.
        const settings =
            (await this.issuance.getIssuanceConfiguration(tenantId))
                .registrationCertificate ?? callerSettings;
        const { material, fingerprint, cache, cached } = await this.current(
            tenantId,
            settings,
        );
        if (cached) {
            return cached;
        }

        if (material.providesAttestations.length === 0) {
            this.logger.warn(
                `[${tenantId}] registrationCertificate generate mode: ${NO_CREDENTIAL_TYPES_MESSAGE}`,
            );
            return undefined;
        }

        const body: Partial<RegistrationCertificateCreation> =
            issuerRegistrationCertificateBody(
                settings,
                material.providesAttestations,
            );
        const resolved = await this.registrar.resolveRegistrationCertificate(
            { body },
            {},
            v4(),
            tenantId,
        );

        const unlisted = unlistedCredentialTypes(resolved.payload, material);
        if (unlisted.length > 0) {
            this.logger.warn(
                `[${tenantId}] ${unlistedCredentialTypesMessage(unlisted)}; the certificate is revoked and not published`,
            );
            await this.revokeReplaced(tenantId, resolved.jwt);
            return undefined;
        }

        if (
            cache?.jwt &&
            cache.jwt !== resolved.jwt &&
            isJwtActive(cache.jwt)
        ) {
            await this.revokeReplaced(tenantId, cache.jwt);
        }

        await this.issuance.updateRegistrationCertificateCache(tenantId, {
            jwt: resolved.jwt,
            fingerprint,
            issuedAt:
                typeof resolved.payload.iat === "number"
                    ? resolved.payload.iat
                    : undefined,
            expiresAt:
                typeof resolved.payload.exp === "number"
                    ? resolved.payload.exp
                    : undefined,
        });

        return resolved.jwt;
    }

    private async revokeReplaced(tenantId: string, jwt: string) {
        try {
            const revoked =
                await this.registrar.revokeRegistrationCertificateByJwt(
                    tenantId,
                    jwt,
                );
            if (!revoked) {
                this.logger.warn(
                    `[${tenantId}] Previous issuer registration certificate was not found as active during replacement`,
                );
            }
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Failed to revoke previous issuer registration certificate during replacement: ${error instanceof Error ? error.message : "unknown error"}`,
            );
        }
    }
}
