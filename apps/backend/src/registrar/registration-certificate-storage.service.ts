import {
    BadGatewayException,
    BadRequestException,
    Inject,
    Injectable,
    Logger,
} from "@nestjs/common";
import { decodeJwt } from "jose";
import type { TokenPayload } from "../auth/token.decorator.js";
import { IssuanceConfigurationNotFound } from "../issuer/configuration/issuance/domain/issuance-configuration.js";
import { IssuanceService } from "../issuer/configuration/issuance/issuance.service.js";
import {
    NO_CREDENTIAL_TYPES_MESSAGE,
    type RegistrationCertificateMaterial,
    unlistedCredentialTypes,
} from "../issuer/issuance/oid4vci/domain/issuer-registration-certificate.js";
import { PresentationConfigService } from "../verifier/presentations/configuration/presentation-config.service.js";
import { resolveDcqlTenantUrl } from "../verifier/presentations/domain/dcql-tenant-url.js";
import type { RegistrationCertificatePurpose } from "../verifier/presentations/dto/registration-certificate.dto.js";
import {
    PRESENTATION_SETTINGS,
    type PresentationSettings,
} from "../verifier/presentations/presentation-settings.js";
import type { IssuedCertificate } from "./issued-certificate.js";
import { revokeUnstored } from "./revoke-unstored.js";

/**
 * What a verifier registration certificate is requested for: a presentation
 * configuration's DCQL query and the purpose and privacy policy, given in the
 * request or kept from the last request.
 */
export interface VerifierCertificateRequest {
    presentationConfigId: string;
    /** The configuration's description, else its ID; a default certificate name. */
    defaultName: string;
    /** The DCQL query with `<TENANT_URL>` resolved, as wallets receive it. */
    dcqlQuery: unknown;
    purpose: RegistrationCertificatePurpose[];
    privacyPolicy: string;
}

/** What an issuer registration certificate is requested for. */
export interface IssuerCertificateRequest {
    /** The credential types the certificate must list. */
    credentialTypes: RegistrationCertificateMaterial;
    /** Support URI the certificate is requested with; kept for the next request. */
    supportUri?: string;
}

/**
 * Registrar-neutral part of requesting registration certificates. It reads
 * what a certificate is requested for and stores the issued JWT: in the
 * presentation configuration for a verifier (`registration_cert`, with the
 * purpose and privacy policy, so the next request can reuse them), in the
 * issuance configuration for an issuer. Storing runs the checks of every
 * stored certificate, such as the overasking check; a certificate that is
 * not stored is revoked at the registrar. Registrar adapters do the
 * registrar-specific calls in between.
 */
@Injectable()
export class RegistrationCertificateStorage {
    private readonly logger = new Logger(RegistrationCertificateStorage.name);

    constructor(
        private readonly presentationConfigs: PresentationConfigService,
        private readonly issuance: IssuanceService,
        @Inject(PRESENTATION_SETTINGS)
        private readonly settings: PresentationSettings,
    ) {}

    /**
     * What a verifier registration certificate for the presentation
     * configuration is requested for. The purpose and privacy policy of the
     * request win; missing ones are taken from the configuration's
     * `registration_cert`.
     *
     * @throws BadRequestException when neither has a purpose or privacy policy.
     */
    async verifierRequest(
        tenantId: string,
        presentationConfigId: string,
        given: {
            purpose?: RegistrationCertificatePurpose[];
            privacyPolicy?: string;
        },
    ): Promise<VerifierCertificateRequest> {
        const config = await this.presentationConfigs.getPresentationConfig(
            presentationConfigId,
            tenantId,
        );
        const stored = config.registration_cert;
        const purpose = given.purpose ?? stored?.purpose;
        const privacyPolicy = given.privacyPolicy ?? stored?.privacy_policy;
        if (!purpose?.length || !privacyPolicy) {
            throw new BadRequestException(
                `Give the purpose and the privacy policy for presentation configuration ${config.id}; it keeps none from an earlier request.`,
            );
        }
        return {
            presentationConfigId: config.id,
            defaultName: config.description?.trim() || config.id,
            dcqlQuery: resolveDcqlTenantUrl(
                config.dcql_query,
                this.settings.publicUrl,
                tenantId,
            ),
            purpose,
            privacyPolicy,
        };
    }

    /**
     * Store a verifier registration certificate in the presentation
     * configuration, with the purpose and privacy policy it was requested
     * with. A certificate that fails the checks or cannot be stored is
     * revoked at the registrar.
     */
    async storeVerifier(
        tenantId: string,
        request: VerifierCertificateRequest,
        issued: IssuedCertificate,
        actor: TokenPayload,
    ): Promise<void> {
        try {
            await this.presentationConfigs.updatePresentationConfig(
                request.presentationConfigId,
                tenantId,
                {
                    registration_cert: {
                        jwt: issued.value,
                        purpose: request.purpose,
                        privacy_policy: request.privacyPolicy,
                    },
                },
                actor,
            );
        } catch (error) {
            await revokeUnstored(this.logger, tenantId, issued, "registration");
            throw error;
        }
        this.logger.log(
            `[${tenantId}] Stored ${issued.registrar} registration certificate ${issued.id} in presentation configuration ${request.presentationConfigId}`,
        );
    }

    /**
     * What an issuer registration certificate of the tenant is requested
     * for: the credential types of its credential configurations.
     *
     * @throws BadRequestException when no credential configuration has a
     * `vct` or `docType`.
     */
    async issuerRequest(
        tenantId: string,
        given: { supportUri?: string },
    ): Promise<IssuerCertificateRequest> {
        const credentialTypes =
            await this.issuance.registrationCertificateMaterial(tenantId);
        if (credentialTypes.providesAttestations.length === 0) {
            throw new BadRequestException(NO_CREDENTIAL_TYPES_MESSAGE);
        }
        return { credentialTypes, supportUri: given.supportUri };
    }

    /**
     * Store an issuer registration certificate in the issuance
     * configuration and enable it. A certificate that does not list every
     * credential type, or cannot be stored, is revoked at the registrar.
     *
     * @throws BadGatewayException when the certificate misses a credential type.
     */
    async storeIssuer(
        tenantId: string,
        request: IssuerCertificateRequest,
        issued: IssuedCertificate,
        actor: TokenPayload,
    ): Promise<void> {
        let unlisted: string[];
        try {
            unlisted = unlistedCredentialTypes(
                decodeJwt(issued.value) as Record<string, unknown>,
                request.credentialTypes,
            );
        } catch {
            await revokeUnstored(this.logger, tenantId, issued, "registration");
            throw new BadGatewayException(
                `The ${issued.registrar} issued a registration certificate that is not a JWT, so it was revoked.`,
            );
        }
        if (unlisted.length > 0) {
            await revokeUnstored(this.logger, tenantId, issued, "registration");
            throw new BadGatewayException(
                `The ${issued.registrar} issued a registration certificate that does not list ${unlisted.join(", ")}, so it was revoked.`,
            );
        }
        try {
            // Other settings, such as the privacy policy, are kept; a tenant
            // without issuance configuration gets one.
            const current = await this.currentIssuanceConfig(tenantId);
            await this.issuance.storeIssuanceConfiguration(
                tenantId,
                {
                    registrationCertificate: {
                        ...current?.registrationCertificate,
                        enabled: true,
                        jwt: issued.value,
                        ...(request.supportUri
                            ? { supportUri: request.supportUri }
                            : {}),
                    },
                },
                actor,
            );
        } catch (error) {
            await revokeUnstored(this.logger, tenantId, issued, "registration");
            throw error;
        }
        this.logger.log(
            `[${tenantId}] Stored ${issued.registrar} registration certificate ${issued.id} in the issuance configuration`,
        );
    }

    private currentIssuanceConfig(tenantId: string) {
        return this.issuance
            .getIssuanceConfiguration(tenantId)
            .catch((error: unknown) => {
                if (error instanceof IssuanceConfigurationNotFound) {
                    return undefined;
                }
                throw error;
            });
    }
}
