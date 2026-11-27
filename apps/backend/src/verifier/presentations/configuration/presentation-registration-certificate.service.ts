import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { CertService } from "../../../crypto/key/cert/cert.service.js";
import { KeyUsageType } from "../../../crypto/key/types/key-usage-type.js";
import { checkRegistrationCertificate } from "../../../registrar/domain/registration-certificate-check.js";
import { resolveDcqlTenantUrl } from "../domain/dcql-tenant-url.js";
import type { PresentationConfig } from "../entities/presentation-config.entity.js";
import {
    PRESENTATION_SETTINGS,
    type PresentationSettings,
} from "../presentation-settings.js";

/**
 * The registration certificate of a presentation configuration
 * (`registration_cert.jwt`). It comes from a registrar, for example the EUDI
 * Hub, and is attached to the request object as is. It is checked when the
 * configuration is saved and again for every request: decodable, within its
 * validity period, issued to the relying party (or intermediary) of the
 * access certificate (see `checkRegistrationCertificate`) and, unless
 * `SKIP_OVERASKING_CHECK` is set,
 * authorizing every credential the DCQL query requests.
 */
@Injectable()
export class PresentationRegistrationCertificateService {
    constructor(
        @Inject(PRESENTATION_SETTINGS)
        private readonly settings: PresentationSettings,
        private readonly certService: CertService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext(PresentationRegistrationCertificateService.name);
    }

    /**
     * The JWT to attach to a request object, or `undefined` when the
     * configuration has none.
     *
     * @param resolvedDcqlQuery - The DCQL query of the request, with
     * `<TENANT_URL>` resolved.
     * @param accessCertificate - The leaf certificate the request object
     * carries in `x5c`; `undefined` for a request without one (OpenID
     * Federation), which is not matched.
     * @throws BadRequestException when the certificate fails its checks.
     */
    forRequest(
        presentationConfig: Pick<
            PresentationConfig,
            "id" | "tenantId" | "registration_cert"
        >,
        resolvedDcqlQuery: unknown,
        accessCertificate: string | undefined,
        requestId: string,
    ): string | undefined {
        const jwt = presentationConfig.registration_cert?.jwt;
        if (!jwt) {
            return undefined;
        }
        this.check(
            jwt,
            resolvedDcqlQuery,
            accessCertificate,
            presentationConfig.tenantId,
            { requestId, configId: presentationConfig.id },
        );
        return jwt;
    }

    /**
     * Check the registration certificate before the configuration is saved,
     * against the DCQL query with `<TENANT_URL>` resolved and against the
     * access key chain requests would be signed with (`accessKeyChainId`, or
     * the tenant's default access key chain), so a certificate that requests
     * would refuse fails the save with `400` instead. Without an access key
     * chain, the access certificate match is left to the request.
     *
     * @throws BadRequestException when the certificate fails its checks.
     */
    async validate(
        presentationConfig: Pick<
            PresentationConfig,
            "id" | "tenantId" | "registration_cert"
        > & { dcql_query: unknown; accessKeyChainId?: string | null },
    ): Promise<void> {
        const jwt = presentationConfig.registration_cert?.jwt;
        if (!jwt) {
            return;
        }
        this.check(
            jwt,
            resolveDcqlTenantUrl(
                presentationConfig.dcql_query,
                this.settings.publicUrl,
                presentationConfig.tenantId,
            ),
            await this.accessCertificate(
                presentationConfig.tenantId,
                presentationConfig.accessKeyChainId,
            ),
            presentationConfig.tenantId,
            { configId: presentationConfig.id },
        );
    }

    /**
     * Leaf certificate of the access key chain a presentation configuration
     * signs with (`accessKeyChainId`, or the tenant's default), or
     * `undefined` when the tenant has none (yet).
     */
    async accessCertificate(
        tenantId: string,
        accessKeyChainId: string | null | undefined,
    ): Promise<string | undefined> {
        try {
            const cert = await this.certService.find({
                tenantId,
                type: KeyUsageType.Access,
                keyId: accessKeyChainId ?? undefined,
                skipValidation: true,
            });
            return cert.crt[0];
        } catch (error) {
            if (error instanceof NotFoundException) {
                return undefined;
            }
            throw error;
        }
    }

    private check(
        jwt: string,
        dcqlQuery: unknown,
        accessCertificate: string | undefined,
        tenantId: string,
        context: { requestId?: string; configId?: string },
    ): void {
        const result = checkRegistrationCertificate(jwt, dcqlQuery, {
            skipOveraskingCheck: this.settings.skipOveraskingCheck,
            accessCertificate,
        });
        if (result.problem) {
            const { code, message, unauthorizedCredentialIds } = result.problem;
            const fields = {
                tenantId,
                ...context,
                ...(unauthorizedCredentialIds
                    ? { unauthorizedIds: unauthorizedCredentialIds }
                    : {}),
            };
            const text = `${message}${code === "OVERASKING" ? " (overasking prevented)" : ""}`;
            if (
                code === "INVALID_JWT" ||
                code === "OVERASKING" ||
                code === "ACCESS_CERTIFICATE_MISMATCH"
            ) {
                this.logger.error(fields, text);
            } else {
                this.logger.warn(fields, text);
            }
            throw new BadRequestException(message);
        }
        const credentials = (dcqlQuery as { credentials?: unknown } | null)
            ?.credentials;
        if (
            this.settings.skipOveraskingCheck &&
            Array.isArray(credentials) &&
            credentials.length > 0
        ) {
            this.logger.warn(
                { tenantId, ...context },
                "SKIP_OVERASKING_CHECK is enabled: not checking that the registration certificate authorizes the requested DCQL credentials",
            );
        }
    }
}
