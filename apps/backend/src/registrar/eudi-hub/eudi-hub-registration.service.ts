import {
    BadGatewayException,
    BadRequestException,
    Injectable,
    Logger,
} from "@nestjs/common";
import { decodeJwt } from "jose";
import type { TokenPayload } from "../../auth/token.decorator.js";
import { IssuanceConfigurationNotFound } from "../../issuer/configuration/issuance/domain/issuance-configuration.js";
import { IssuanceService } from "../../issuer/configuration/issuance/issuance.service.js";
import {
    NO_CREDENTIAL_TYPES_MESSAGE,
    unlistedCredentialTypes,
} from "../../issuer/issuance/oid4vci/domain/issuer-registration-certificate.js";
import { PresentationConfigService } from "../../verifier/presentations/configuration/presentation-config.service.js";
import {
    hubCredentialsForDcql,
    sameCredentialRequest,
} from "./domain/hub-credentials.js";
import type {
    EudiHubIssuerRegistrationCertificateRequest,
    EudiHubPresentationRegistrationCertificateRequest,
} from "./dto/eudi-hub-request.dto.js";
import type {
    EudiHubOrganizationDetailsDto,
    EudiHubRegistrationCertificateDto,
} from "./dto/eudi-hub-response.dto.js";
import {
    EudiHubClient,
    type EudiHubCredentialIssuance,
    type EudiHubRegistrationCertificate,
    type EudiHubRegistrationCertificateBase,
} from "./eudi-hub.client.js";
import { eudiHubHttpException } from "./eudi-hub-errors.js";

/** The organization and token of a request to the EUDI Hub. */
type HubTarget = { token: string; organizationId: string };

/**
 * Requests registration certificates from the German EUDI Hub with an access
 * token the caller copied from the portal, and stores them as imported
 * certificates: in a presentation configuration for a verifier, in the
 * issuance configuration for an issuer. The token is passed through for the
 * request and never stored or logged. The EUDI Hub cannot be reached without
 * a fresh token, so these certificates are not renewed automatically.
 */
@Injectable()
export class EudiHubRegistrationService {
    private readonly logger = new Logger(EudiHubRegistrationService.name);

    constructor(
        private readonly client: EudiHubClient,
        private readonly presentationConfigs: PresentationConfigService,
        private readonly issuance: IssuanceService,
    ) {}

    /** Identifiers, service descriptions and contact data the dialog prefills. */
    async organizationDetails(
        tenantId: string,
        { token, organizationId }: HubTarget,
    ): Promise<EudiHubOrganizationDetailsDto> {
        try {
            return await this.client.getOrganization(token, organizationId);
        } catch (error) {
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                error,
                "Could not read the organization at the EUDI Hub",
            );
        }
    }

    /**
     * Request a verifier registration certificate for the DCQL query of a
     * presentation configuration and store it there as `registration_cert.jwt`.
     * A credential request with the same credentials, purpose and privacy
     * policy is used again; otherwise one is created. Storing runs the checks
     * of an imported certificate, including the overasking check; a
     * certificate that is not stored is revoked at the EUDI Hub.
     */
    async requestPresentationCertificate(
        tenantId: string,
        dto: EudiHubPresentationRegistrationCertificateRequest,
        actor: TokenPayload,
    ): Promise<EudiHubRegistrationCertificateDto> {
        const config = await this.presentationConfigs.getPresentationConfig(
            dto.presentationConfigId,
            tenantId,
        );
        const mapping = hubCredentialsForDcql(config.dcql_query);
        if (mapping.problem !== undefined) {
            throw new BadRequestException(
                `The DCQL query of presentation configuration ${config.id} cannot be registered at the EUDI Hub. ${mapping.problem}.`,
            );
        }
        const wanted = {
            credentials: mapping.credentials,
            purpose: dto.purpose,
            privacyPolicy: dto.privacyPolicy,
        };
        const name = (dto.name ?? config.description?.trim()) || config.id;

        let certificate: EudiHubRegistrationCertificate;
        let credentialRequestId: string;
        let reused = false;
        try {
            const existing = (
                await this.client.listCredentialRequests(
                    dto.token,
                    dto.organizationId,
                    dto.environment,
                )
            ).find((request) => sameCredentialRequest(request, wanted));
            reused = existing !== undefined;
            credentialRequestId = (
                existing ??
                (await this.client.createCredentialRequest(
                    dto.token,
                    dto.organizationId,
                    {
                        name,
                        ...wanted,
                        environments: [dto.environment],
                    },
                ))
            ).id;
            certificate = await this.client.createRegistrationCertificate(
                dto.token,
                dto.organizationId,
                {
                    ...this.certificateBase(dto, name),
                    type: "credentialRequest",
                    credentialRequestId,
                },
            );
        } catch (error) {
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                error,
                "The EUDI Hub did not issue a registration certificate",
            );
        }

        const jwt = await this.download(tenantId, dto, certificate.id);
        try {
            await this.presentationConfigs.updatePresentationConfig(
                config.id,
                tenantId,
                {
                    registration_cert: {
                        ...(config.registration_cert ?? {}),
                        jwt,
                    },
                },
                actor,
            );
        } catch (error) {
            await this.revoke(tenantId, dto, certificate.id);
            throw error;
        }
        this.logger.log(
            `[${tenantId}] Stored EUDI Hub registration certificate ${certificate.id} (${dto.environment}) in presentation configuration ${config.id}`,
        );
        return {
            id: certificate.id,
            environment: dto.environment,
            expirationDate: certificate.expirationDate,
            credentialRequestId,
            reusedCredentialRequest: reused,
        };
    }

    /**
     * Request an issuer registration certificate for the credential types of
     * the tenant's credential configurations and store it in the issuance
     * configuration in import mode. Each type needs a credential issuance at
     * the EUDI Hub; missing ones are created. A certificate that does not
     * list every type, or that is not stored, is revoked at the EUDI Hub.
     */
    async requestIssuerCertificate(
        tenantId: string,
        dto: EudiHubIssuerRegistrationCertificateRequest,
        actor: TokenPayload,
    ): Promise<EudiHubRegistrationCertificateDto> {
        const material =
            await this.issuance.registrationCertificateMaterial(tenantId);
        if (material.providesAttestations.length === 0) {
            throw new BadRequestException(NO_CREDENTIAL_TYPES_MESSAGE);
        }
        const name = dto.name ?? "Issuer registration certificate";

        let certificate: EudiHubRegistrationCertificate;
        const credentialIssuanceIds: string[] = [];
        try {
            const existing = await this.client.listCredentialIssuances(
                dto.token,
                dto.organizationId,
                dto.environment,
            );
            for (const { format, type } of material.providesAttestations) {
                const issuance: EudiHubCredentialIssuance =
                    existing.find(
                        ({ credential }) =>
                            credential?.format === format &&
                            credential?.type === type,
                    ) ??
                    (await this.client.createCredentialIssuance(
                        dto.token,
                        dto.organizationId,
                        {
                            name: type,
                            credential: { format, type },
                            environments: [dto.environment],
                        },
                    ));
                credentialIssuanceIds.push(issuance.id);
            }
            certificate = await this.client.createRegistrationCertificate(
                dto.token,
                dto.organizationId,
                {
                    ...this.certificateBase(dto, name),
                    type: "credentialIssuance",
                    credentialIssuanceIds,
                },
            );
        } catch (error) {
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                error,
                "The EUDI Hub did not issue a registration certificate",
            );
        }

        const jwt = await this.download(tenantId, dto, certificate.id);
        const unlisted = unlistedCredentialTypes(
            decodeJwt(jwt) as Record<string, unknown>,
            material,
        );
        if (unlisted.length > 0) {
            await this.revoke(tenantId, dto, certificate.id);
            throw new BadGatewayException(
                `The EUDI Hub issued a registration certificate that does not list ${unlisted.join(", ")}, so it was revoked.`,
            );
        }

        try {
            // Settings such as the privacy policy of a generated certificate
            // are kept; a tenant without issuance configuration gets one.
            const current = await this.issuance
                .getIssuanceConfiguration(tenantId)
                .catch((error: unknown) => {
                    if (error instanceof IssuanceConfigurationNotFound) {
                        return undefined;
                    }
                    throw error;
                });
            await this.issuance.storeIssuanceConfiguration(
                tenantId,
                {
                    registrationCertificate: {
                        ...(current?.registrationCertificate ?? {}),
                        enabled: true,
                        mode: "import",
                        jwt,
                    },
                },
                actor,
            );
        } catch (error) {
            await this.revoke(tenantId, dto, certificate.id);
            throw error;
        }
        // A certificate generated earlier is not served in import mode; a
        // later switch back to generate mode requests a new one.
        await this.issuance
            .updateRegistrationCertificateCache(tenantId, null)
            .catch((error: unknown) =>
                // The certificate is stored, and import mode does not serve
                // the cache, so the request still succeeds.
                this.logger.warn(
                    `[${tenantId}] Could not clear the generated issuer registration certificate cache: ${error instanceof Error ? error.message : String(error)}`,
                ),
            );
        this.logger.log(
            `[${tenantId}] Stored EUDI Hub registration certificate ${certificate.id} (${dto.environment}) in the issuance configuration`,
        );
        return {
            id: certificate.id,
            environment: dto.environment,
            expirationDate: certificate.expirationDate,
            credentialIssuanceIds,
        };
    }

    private certificateBase(
        dto: EudiHubIssuerRegistrationCertificateRequest,
        name: string,
    ): EudiHubRegistrationCertificateBase {
        return {
            name,
            environment: dto.environment,
            identifier: dto.identifier,
            serviceDescription: dto.serviceDescription,
            supportUri: dto.supportUri,
            infoUri: dto.infoUri,
        };
    }

    /** The certificate's JWT; a certificate that cannot be downloaded is revoked. */
    private async download(
        tenantId: string,
        target: HubTarget,
        certificateId: string,
    ): Promise<string> {
        try {
            return await this.client.downloadRegistrationCertificate(
                target.token,
                target.organizationId,
                certificateId,
            );
        } catch (error) {
            await this.revoke(tenantId, target, certificateId);
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                error,
                `The EUDI Hub issued registration certificate ${certificateId}, but it could not be downloaded, so it was revoked`,
            );
        }
    }

    /** Best-effort revocation of a certificate EUDIPLO did not store. */
    private async revoke(
        tenantId: string,
        target: HubTarget,
        certificateId: string,
    ): Promise<void> {
        try {
            await this.client.revokeRegistrationCertificate(
                target.token,
                target.organizationId,
                certificateId,
            );
            this.logger.warn(
                `[${tenantId}] Did not store EUDI Hub registration certificate ${certificateId}; revoked it at the EUDI Hub`,
            );
        } catch (error) {
            this.logger.error(
                `[${tenantId}] Did not store EUDI Hub registration certificate ${certificateId} and could not revoke it at the EUDI Hub; revoke it in the portal: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
