import { HttpException, Injectable, Logger } from "@nestjs/common";
import { AccessCertificateStorage } from "../access-certificate-storage.service.js";
import type { IssuedCertificate } from "../issued-certificate.js";
import { revokeUnstored } from "../revoke-unstored.js";
import type { EudiHubAccessCertificateRequest } from "./dto/eudi-hub-request.dto.js";
import type {
    EudiHubAccessCertificateDto,
    EudiHubOrganizationDto,
} from "./dto/eudi-hub-response.dto.js";
import {
    EudiHubAccessCertificate,
    EudiHubClient,
    EudiHubRequestError,
} from "./eudi-hub.client.js";
import { EUDI_HUB, eudiHubHttpException } from "./eudi-hub-errors.js";

/** How many certificates of the same name a lost answer is looked for in. */
const MAX_RECOVERY_DOWNLOADS = 5;

/**
 * Requests access certificates from the German EUDI Hub with an access token
 * the caller copied from the portal. The token is passed through for the
 * request and never stored or logged.
 */
@Injectable()
export class EudiHubService {
    private readonly logger = new Logger(EudiHubService.name);

    constructor(
        private readonly client: EudiHubClient,
        private readonly storage: AccessCertificateStorage,
    ) {}

    /** The organizations the user of the token is assigned to. */
    async listOrganizations(
        tenantId: string,
        token: string,
    ): Promise<EudiHubOrganizationDto[]> {
        try {
            return await this.client.listOrganizations(token);
        } catch (error) {
            throw this.toHttpException(
                tenantId,
                error,
                "Could not read the organizations of the EUDI Hub user",
            );
        }
    }

    /**
     * Request an access certificate for a standalone access key chain and
     * store it there.
     *
     * When the request gets no answer or the EUDI Hub fails, it may still
     * have issued the certificate. Its valid certificates with the same name
     * are then searched for one with the key's public key, and a match is
     * stored as if the request had succeeded. A certificate issued by this
     * request that EUDIPLO cannot download or store is revoked at the EUDI
     * Hub, so no unused certificate stays valid.
     */
    async requestAccessCertificate(
        tenantId: string,
        dto: EudiHubAccessCertificateRequest,
    ): Promise<EudiHubAccessCertificateDto> {
        const { token, organizationId, keyId, environment, supportUri } = dto;
        const { csr, defaultName } = await this.storage.prepare(
            tenantId,
            keyId,
            EUDI_HUB,
        );
        const name = dto.name ?? defaultName;

        let certificate: EudiHubAccessCertificate;
        try {
            certificate = await this.client.createAccessCertificate(
                token,
                organizationId,
                { name, csr, environment, supportUri },
            );
        } catch (error) {
            const recovered = this.mayHaveIssued(error)
                ? await this.findIssuedCertificate(tenantId, dto, name)
                : undefined;
            if (!recovered) {
                throw this.toHttpException(
                    tenantId,
                    error,
                    "The EUDI Hub did not issue an access certificate",
                );
            }
            this.logger.warn(
                `[${tenantId}] The EUDI Hub request for key chain ${keyId} failed, but the EUDI Hub lists access certificate ${recovered.certificate.id} for its key; storing that certificate`,
            );
            // Not issued by this request, so it is not revoked either.
            return this.store(tenantId, dto, recovered.certificate, {
                registrar: EUDI_HUB,
                id: recovered.certificate.id,
                value: recovered.crt,
            });
        }

        const revoke = () =>
            this.client.revokeAccessCertificate(
                token,
                organizationId,
                certificate.id,
            );
        let crt: string;
        try {
            crt = await this.client.downloadAccessCertificate(
                token,
                organizationId,
                certificate.id,
            );
        } catch (error) {
            await revokeUnstored(
                this.logger,
                tenantId,
                {
                    registrar: EUDI_HUB,
                    id: certificate.id,
                    value: undefined,
                    revoke,
                },
                "access",
                "Could not download",
            );
            throw this.toHttpException(
                tenantId,
                error,
                `The EUDI Hub issued access certificate ${certificate.id}, but it could not be downloaded, so it was revoked`,
            );
        }
        return this.store(tenantId, dto, certificate, {
            registrar: EUDI_HUB,
            id: certificate.id,
            value: crt,
            revoke,
        });
    }

    private async store(
        tenantId: string,
        dto: EudiHubAccessCertificateRequest,
        certificate: EudiHubAccessCertificate,
        issued: IssuedCertificate,
    ): Promise<EudiHubAccessCertificateDto> {
        const certId = await this.storage.store(
            tenantId,
            dto.keyId,
            issued,
            `Access certificate from the EUDI Hub (${dto.environment}, ID: ${certificate.id})`,
        );
        return {
            id: certificate.id,
            certId,
            crt: issued.value,
            environment: dto.environment,
            clientId: certificate.clientId,
            expirationDate: certificate.expirationDate,
        };
    }

    /** No answer, or a server error: the certificate may exist anyway. */
    private mayHaveIssued(error: unknown): boolean {
        return (
            error instanceof EudiHubRequestError &&
            !error.blocked &&
            (error.status === undefined || error.status >= 500)
        );
    }

    /**
     * A valid certificate of the organization in the environment with the
     * requested name and the key's public key, other than the one the key
     * chain holds already. Undefined when there is none or the EUDI Hub
     * cannot be queried.
     */
    private async findIssuedCertificate(
        tenantId: string,
        dto: EudiHubAccessCertificateRequest,
        name: string,
    ): Promise<
        { certificate: EudiHubAccessCertificate; crt: string } | undefined
    > {
        try {
            const issuedForKey = await this.storage.issuedFor(
                tenantId,
                dto.keyId,
            );
            const candidates = (
                await this.client.listAccessCertificates(
                    dto.token,
                    dto.organizationId,
                    dto.environment,
                )
            )
                .filter(
                    (entry) => entry.status === "valid" && entry.name === name,
                )
                .slice(0, MAX_RECOVERY_DOWNLOADS);
            for (const certificate of candidates) {
                // One candidate that cannot be downloaded must not hide a matching one.
                let crt: string;
                try {
                    crt = await this.client.downloadAccessCertificate(
                        dto.token,
                        dto.organizationId,
                        certificate.id,
                    );
                } catch (error) {
                    this.logger.warn(
                        `[${tenantId}] Could not download EUDI Hub access certificate ${certificate.id} while looking for the one of key chain ${dto.keyId}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    continue;
                }
                if (issuedForKey(crt)) {
                    return { certificate, crt };
                }
            }
            return undefined;
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Could not check the EUDI Hub for an access certificate of key chain ${dto.keyId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return undefined;
        }
    }

    private toHttpException(
        tenantId: string,
        error: unknown,
        context: string,
    ): HttpException {
        return eudiHubHttpException(this.logger, tenantId, error, context);
    }
}
