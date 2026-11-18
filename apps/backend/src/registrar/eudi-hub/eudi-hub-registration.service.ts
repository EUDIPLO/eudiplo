import { setTimeout as sleep } from "node:timers/promises";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type { TokenPayload } from "../../auth/token.decorator.js";
import type { IssuedCertificate } from "../issued-certificate.js";
import {
    type IssuerCertificateRequest,
    RegistrationCertificateStorage,
} from "../registration-certificate-storage.service.js";
import { revokeUnstored } from "../revoke-unstored.js";
import {
    hubCredentialsForDcql,
    hubPurpose,
    MAX_HUB_TEXTS,
    sameCredentialRequest,
} from "./domain/hub-credentials.js";
import {
    type EudiHubIssuerRegistrationCertificateRequest,
    type EudiHubPresentationRegistrationCertificateRequest,
    HttpUrlSchema,
    PurposeTextSchema,
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
    EudiHubRequestError,
} from "./eudi-hub.client.js";
import {
    EUDI_HUB,
    eudiHubHttpException,
    isEudiHubFailure,
} from "./eudi-hub-errors.js";

/**
 * Pause between two credential issuance creations at the EUDI Hub, which
 * refuses creations that arrive at the same time.
 */
const CREATION_PAUSE_MS = 300;

/** The organization and token of a request to the EUDI Hub. */
type HubTarget = { token: string; organizationId: string };

/**
 * Requests registration certificates from the German EUDI Hub with an access
 * token the caller copied from the portal, and stores them through
 * {@link RegistrationCertificateStorage}: in a presentation configuration
 * for a verifier, in the issuance configuration for an issuer. The token is
 * passed through for the request and never stored or logged. The EUDI Hub
 * cannot be reached without a fresh token, so these certificates are not
 * renewed automatically.
 */
@Injectable()
export class EudiHubRegistrationService {
    private readonly logger = new Logger(EudiHubRegistrationService.name);

    constructor(
        private readonly client: EudiHubClient,
        private readonly storage: RegistrationCertificateStorage,
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
     * presentation configuration and store it there as `registration_cert`,
     * with the purpose and privacy policy. Missing ones are taken from the
     * configuration, so renewing needs neither again. A credential request
     * with the same credentials, privacy policy and sent purpose texts is used again;
     * otherwise one is created. Storing runs the checks of every stored
     * certificate, including the overasking check; a certificate that is not
     * stored is revoked at the EUDI Hub.
     */
    async requestPresentationCertificate(
        tenantId: string,
        dto: EudiHubPresentationRegistrationCertificateRequest,
        actor: TokenPayload,
    ): Promise<EudiHubRegistrationCertificateDto> {
        const request = await this.storage.verifierRequest(
            tenantId,
            dto.presentationConfigId,
            { purpose: dto.purpose, privacyPolicy: dto.privacyPolicy },
        );
        const purpose = PurposeTextSchema.safeParse(request.purpose);
        if (!purpose.success) {
            throw new BadRequestException(
                `The purpose of presentation configuration ${request.presentationConfigId} does not suit the EUDI Hub: ${purpose.error.issues.map((issue) => issue.message).join(" ")}`,
            );
        }
        // Every text is stored with the certificate; the EUDI Hub gets those
        // it accepts.
        const { sent, notSent } = hubPurpose(purpose.data);
        if (notSent.length > 0) {
            this.logger.log(
                `[${tenantId}] Purpose texts in ${notSent.join(", ")} of presentation configuration ${request.presentationConfigId} are kept but not sent: the EUDI Hub accepts at most ${MAX_HUB_TEXTS} texts with two-letter language codes`,
            );
        }
        // A kept privacy policy was not checked like one in the request.
        if (!HttpUrlSchema.safeParse(request.privacyPolicy).success) {
            throw new BadRequestException(
                `The privacy policy of presentation configuration ${request.presentationConfigId} is not an http or https URL, which the EUDI Hub needs.`,
            );
        }
        const mapping = hubCredentialsForDcql(request.dcqlQuery);
        if (mapping.problem !== undefined) {
            throw new BadRequestException(
                `The DCQL query of presentation configuration ${request.presentationConfigId} cannot be registered at the EUDI Hub. ${mapping.problem}.`,
            );
        }
        const wanted = {
            credentials: mapping.credentials,
            purpose: sent,
            privacyPolicy: request.privacyPolicy,
        };
        const name = dto.name ?? request.defaultName;

        let credentialRequestId: string;
        let reused = false;
        try {
            const existing = (
                await this.client.listCredentialRequests(
                    dto.token,
                    dto.organizationId,
                    dto.environment,
                )
            ).find((candidate) => sameCredentialRequest(candidate, wanted));
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
        } catch (error) {
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                error,
                "Could not find or register the credential request at the EUDI Hub",
                { beforeCertificate: true },
            );
        }
        let certificate: EudiHubRegistrationCertificate;
        try {
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

        const issued = await this.download(tenantId, dto, certificate.id);
        await this.storage.storeVerifier(tenantId, request, issued, actor);
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
     * configuration. Each type needs a credential issuance at the EUDI Hub;
     * missing ones are created. A certificate that does not list every type,
     * or that is not stored, is revoked at the EUDI Hub.
     */
    async requestIssuerCertificate(
        tenantId: string,
        dto: EudiHubIssuerRegistrationCertificateRequest,
        actor: TokenPayload,
    ): Promise<EudiHubRegistrationCertificateDto> {
        const request = await this.storage.issuerRequest(tenantId, {
            supportUri: dto.supportUri,
        });
        const name = dto.name ?? "Issuer registration certificate";

        const credentialIssuanceIds = await this.credentialIssuanceIds(
            tenantId,
            dto,
            request.credentialTypes.providesAttestations,
        );
        let certificate: EudiHubRegistrationCertificate;
        try {
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

        const issued = await this.download(tenantId, dto, certificate.id);
        await this.storage.storeIssuer(tenantId, request, issued, actor);
        return {
            id: certificate.id,
            environment: dto.environment,
            expirationDate: certificate.expirationDate,
            credentialIssuanceIds,
        };
    }

    /**
     * The ID of the EUDI Hub credential issuance of each type, in the order
     * of the types. Existing ones are reused; missing ones are created one
     * after another. When the EUDI Hub does not register a type, the error
     * names it, and the issuances created for the other types stay at the
     * EUDI Hub for the next request to reuse. Its 502s say that no
     * certificate was requested.
     */
    private async credentialIssuanceIds(
        tenantId: string,
        dto: EudiHubIssuerRegistrationCertificateRequest,
        types: IssuerCertificateRequest["credentialTypes"]["providesAttestations"],
    ): Promise<string[]> {
        let existing: EudiHubCredentialIssuance[];
        try {
            existing = await this.client.listCredentialIssuances(
                dto.token,
                dto.organizationId,
                dto.environment,
            );
        } catch (error) {
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                error,
                "Could not read the credential issuances at the EUDI Hub",
                { beforeCertificate: true },
            );
        }

        // One creation at a time, with a pause between them: the EUDI Hub
        // answers concurrent creations with a false 409 ("already exists in
        // the registry"), a bug its maintainers are fixing. Every type is
        // tried even after a refusal, so the error names all of them and a
        // retry reuses the ones created.
        const ids: string[] = [];
        const refused: { type: string; reason: unknown }[] = [];
        let attempts = 0;
        for (const { format, type } of types) {
            const found = existing.find(
                ({ credential }) =>
                    credential?.format === format && credential?.type === type,
            );
            if (found) {
                ids.push(found.id);
                continue;
            }
            // Also after a refusal: it may be such a false 409.
            if (attempts++ > 0) {
                await sleep(CREATION_PAUSE_MS);
            }
            try {
                const issuance = await this.client.createCredentialIssuance(
                    dto.token,
                    dto.organizationId,
                    {
                        name: type,
                        credential: { format, type },
                        environments: [dto.environment],
                    },
                );
                ids.push(issuance.id);
            } catch (reason) {
                refused.push({ type, reason });
            }
        }

        if (refused.length > 0) {
            // A failure of the EUDI Hub itself decides the answer over a
            // refusal, so it is a 502 whenever the EUDI Hub failed.
            const lead =
                refused.find(({ reason }) => isEudiHubFailure(reason)) ??
                refused[0];
            const others = refused.filter((entry) => entry !== lead);
            for (const { type, reason } of others) {
                // Same level as eudiHubHttpException: an error that is not an
                // EUDI Hub request error is a bug, not an EUDI Hub answer.
                const message = `[${tenantId}] The EUDI Hub did not register credential type ${type}: ${reason instanceof Error ? reason.message : String(reason)}`;
                if (reason instanceof EudiHubRequestError) {
                    this.logger.warn(message);
                } else {
                    this.logger.error(message);
                }
            }
            const alsoRefused =
                others.length > 0
                    ? ` (nor ${others.map(({ type }) => type).join(", ")})`
                    : "";
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                lead.reason,
                `The EUDI Hub did not register credential type ${lead.type} for the registration certificate${alsoRefused}`,
                { beforeCertificate: true },
            );
        }
        return ids;
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

    /**
     * The issued certificate with its JWT; a certificate that cannot be
     * downloaded is revoked.
     */
    private async download(
        tenantId: string,
        target: HubTarget,
        certificateId: string,
    ): Promise<IssuedCertificate> {
        const revoke = () =>
            this.client.revokeRegistrationCertificate(
                target.token,
                target.organizationId,
                certificateId,
            );
        try {
            const value = await this.client.downloadRegistrationCertificate(
                target.token,
                target.organizationId,
                certificateId,
            );
            return { registrar: EUDI_HUB, id: certificateId, value, revoke };
        } catch (error) {
            await revokeUnstored(
                this.logger,
                tenantId,
                {
                    registrar: EUDI_HUB,
                    id: certificateId,
                    value: undefined,
                    revoke,
                },
                "registration",
                "Could not download",
            );
            throw eudiHubHttpException(
                this.logger,
                tenantId,
                error,
                `The EUDI Hub issued registration certificate ${certificateId}, but it could not be downloaded, so it was revoked`,
            );
        }
    }
}
