import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
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
 * validity period and, unless `SKIP_OVERASKING_CHECK` is set, authorizing
 * every credential the DCQL query requests.
 */
@Injectable()
export class PresentationRegistrationCertificateService {
    constructor(
        @Inject(PRESENTATION_SETTINGS)
        private readonly settings: PresentationSettings,
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
     * @throws BadRequestException when the certificate fails its checks.
     */
    forRequest(
        presentationConfig: Pick<
            PresentationConfig,
            "id" | "tenantId" | "registration_cert"
        >,
        resolvedDcqlQuery: unknown,
        requestId: string,
    ): string | undefined {
        const jwt = presentationConfig.registration_cert?.jwt;
        if (!jwt) {
            return undefined;
        }
        this.check(jwt, resolvedDcqlQuery, presentationConfig.tenantId, {
            requestId,
            configId: presentationConfig.id,
        });
        return jwt;
    }

    /**
     * Check the registration certificate before the configuration is saved,
     * against the DCQL query with `<TENANT_URL>` resolved, so a certificate
     * that requests would refuse fails the save with `400` instead.
     *
     * @throws BadRequestException when the certificate fails its checks.
     */
    validate(
        presentationConfig: Pick<
            PresentationConfig,
            "id" | "tenantId" | "registration_cert"
        > & { dcql_query: unknown },
    ): void {
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
            presentationConfig.tenantId,
            { configId: presentationConfig.id },
        );
    }

    private check(
        jwt: string,
        dcqlQuery: unknown,
        tenantId: string,
        context: { requestId?: string; configId?: string },
    ): void {
        const result = checkRegistrationCertificate(jwt, dcqlQuery, {
            skipOveraskingCheck: this.settings.skipOveraskingCheck,
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
            if (code === "INVALID_JWT" || code === "OVERASKING") {
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
