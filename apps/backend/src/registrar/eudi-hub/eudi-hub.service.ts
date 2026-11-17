import { X509Certificate } from "node:crypto";
import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger,
} from "@nestjs/common";
import { CertService } from "../../crypto/key/cert/cert.service.js";
import { certificateHoldsKey } from "../../crypto/key/domain/public-jwk-match.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
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
import { eudiHubHttpException } from "./eudi-hub-errors.js";

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
        private readonly keyChainService: KeyChainService,
        private readonly certService: CertService,
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
        const keyChain = await this.keyChainService.getEntity(tenantId, keyId);
        if (
            keyChain.usageType !== KeyUsageType.Access ||
            keyChain.hasInternalCa()
        ) {
            throw new BadRequestException(
                `Key chain ${keyId} is not a standalone access key chain; only those can get an access certificate from the EUDI Hub.`,
            );
        }
        const name = (dto.name ?? keyChain.description?.trim()) || keyId;
        const csr = await this.keyChainService.createCertificateSigningRequest(
            tenantId,
            keyId,
        );

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
            return this.store(
                tenantId,
                dto,
                recovered.certificate,
                recovered.crt,
                false,
            );
        }

        let crt: string;
        try {
            crt = await this.client.downloadAccessCertificate(
                token,
                organizationId,
                certificate.id,
            );
        } catch (error) {
            await this.revoke(tenantId, dto, certificate.id);
            throw this.toHttpException(
                tenantId,
                error,
                `The EUDI Hub issued access certificate ${certificate.id}, but it could not be downloaded, so it was revoked`,
            );
        }
        return this.store(tenantId, dto, certificate, crt, true);
    }

    private async store(
        tenantId: string,
        dto: EudiHubAccessCertificateRequest,
        certificate: EudiHubAccessCertificate,
        crt: string,
        issuedNow: boolean,
    ): Promise<EudiHubAccessCertificateDto> {
        const chain = await this.chainFor(tenantId, crt);
        let certId: string;
        try {
            certId = await this.certService.addCertificate(tenantId, {
                crt: chain,
                keyId: dto.keyId,
                defaultDescription: `Access certificate from the EUDI Hub (${dto.environment}, ID: ${certificate.id})`,
            });
        } catch (error) {
            if (issuedNow) await this.revoke(tenantId, dto, certificate.id);
            throw error;
        }
        this.logger.log(
            `[${tenantId}] Stored EUDI Hub access certificate ${certificate.id} (${dto.environment}) in key chain ${certId}`,
        );
        return {
            id: certificate.id,
            certId,
            crt,
            environment: dto.environment,
            clientId: certificate.clientId,
            expirationDate: certificate.expirationDate,
        };
    }

    /**
     * The certificate followed by the CA that issued it, as wallets need it
     * in `x5c` to build the path to the root they trust (OID4VP 1.0, section
     * 5.9.3). The EUDI Hub signs with an issuing CA below its root and hands
     * out the certificate alone, so the issuing CA is fetched from the URL
     * the certificate names in its Authority Information Access extension.
     * It is added only when it issued the certificate and is not self-signed:
     * a root is the trust anchor and stays out of `x5c`. When it cannot be
     * fetched, the certificate is stored alone and the log says so.
     */
    private async chainFor(tenantId: string, crt: string): Promise<string[]> {
        const leaf = new X509Certificate(crt);
        const url = leaf.infoAccess
            ?.split("\n")
            .map((line) => /^CA Issuers - URI:(\S+)$/.exec(line.trim())?.[1])
            .find((value) => value !== undefined);
        if (!url) {
            this.logger.warn(
                `[${tenantId}] The EUDI Hub access certificate names no issuing CA; storing it without one, so wallets need that CA as trust anchor`,
            );
            return [crt];
        }
        try {
            const issuer = await this.client.fetchCaCertificate(url);
            if (!leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) {
                this.logger.warn(
                    `[${tenantId}] The certificate at ${url} did not issue the EUDI Hub access certificate; storing it without its issuing CA`,
                );
                return [crt];
            }
            return issuer.checkIssued(issuer)
                ? [crt]
                : [crt, issuer.toString()];
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] Could not fetch the issuing CA of the EUDI Hub access certificate from ${url}; storing it without one: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [crt];
        }
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
            const keyChain = await this.keyChainService.getEntity(
                tenantId,
                dto.keyId,
            );
            const current = keyChain.activeCertificate
                ? new X509Certificate(keyChain.activeCertificate)
                : undefined;
            const publicKey = await this.keyChainService.getPublicKey(
                "jwk",
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
                const listed = new X509Certificate(crt);
                if (
                    listed.fingerprint256 !== current?.fingerprint256 &&
                    certificateHoldsKey(listed, publicKey)
                ) {
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

    /** Best-effort revocation of a certificate EUDIPLO could not store. */
    private async revoke(
        tenantId: string,
        dto: EudiHubAccessCertificateRequest,
        certificateId: string,
    ): Promise<void> {
        try {
            await this.client.revokeAccessCertificate(
                dto.token,
                dto.organizationId,
                certificateId,
            );
            this.logger.warn(
                `[${tenantId}] Could not store EUDI Hub access certificate ${certificateId}; revoked it at the EUDI Hub`,
            );
        } catch (error) {
            this.logger.error(
                `[${tenantId}] Could not store EUDI Hub access certificate ${certificateId} and could not revoke it at the EUDI Hub; revoke it in the portal: ${error instanceof Error ? error.message : String(error)}`,
            );
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
