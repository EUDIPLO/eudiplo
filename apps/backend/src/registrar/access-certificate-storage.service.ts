import { X509Certificate } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { CertService } from "../crypto/key/cert/cert.service.js";
import { certificateHoldsKey } from "../crypto/key/domain/public-jwk-match.js";
import { KeyChainService } from "../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../crypto/key/types/key-usage-type.js";
import type { IssuedCertificate } from "./issued-certificate.js";
import { IssuingCaService } from "./issuing-ca.service.js";
import { revokeUnstored } from "./revoke-unstored.js";

/** What a registrar needs to issue an access certificate for a key chain. */
export interface AccessCertificateRequest {
    /** PEM certificate signing request for the key chain's active key. */
    csr: string;
    /** The key chain's description, else its ID; a default certificate name. */
    defaultName: string;
}

/**
 * Registrar-neutral part of requesting an access certificate: the key chain
 * it is for and the CSR, the issued certificate stored as the key chain's
 * active certificate with its issuing CA, and revocation at the registrar
 * when it cannot be stored. Registrar adapters do the registrar-specific
 * calls in between.
 */
@Injectable()
export class AccessCertificateStorage {
    private readonly logger = new Logger(AccessCertificateStorage.name);

    constructor(
        private readonly keyChainService: KeyChainService,
        private readonly certService: CertService,
        private readonly issuingCa: IssuingCaService,
    ) {}

    /**
     * The CSR for a standalone access key chain. Other key chains get their
     * certificate from their own CA or are no access key chains.
     *
     * @throws BadRequestException for any other key chain.
     */
    async prepare(
        tenantId: string,
        keyId: string,
        registrar: string,
    ): Promise<AccessCertificateRequest> {
        const keyChain = await this.keyChainService.getEntity(tenantId, keyId);
        if (
            keyChain.usageType !== KeyUsageType.Access ||
            keyChain.hasInternalCa()
        ) {
            throw new BadRequestException(
                `Key chain ${keyId} is not a standalone access key chain; only those can get an access certificate from the ${registrar}.`,
            );
        }
        return {
            csr: await this.keyChainService.createCertificateSigningRequest(
                tenantId,
                keyId,
            ),
            defaultName: keyChain.description?.trim() || keyId,
        };
    }

    /**
     * Whether a certificate holds the key chain's public key and is not the
     * certificate it holds already: a certificate the registrar issued for
     * this key chain although its answer was lost.
     */
    async issuedFor(
        tenantId: string,
        keyId: string,
    ): Promise<(crt: string) => boolean> {
        const keyChain = await this.keyChainService.getEntity(tenantId, keyId);
        const current = keyChain.activeCertificate
            ? new X509Certificate(keyChain.activeCertificate).fingerprint256
            : undefined;
        const publicKey = await this.keyChainService.getPublicKey(
            "jwk",
            tenantId,
            keyId,
        );
        return (crt) => {
            const certificate = new X509Certificate(crt);
            return (
                certificate.fingerprint256 !== current &&
                certificateHoldsKey(certificate, publicKey)
            );
        };
    }

    /**
     * Store an issued access certificate, followed by its issuing CA, as the
     * active certificate of the key chain. A certificate that cannot be
     * stored, for example because it does not hold the key chain's key, is
     * revoked at the registrar.
     *
     * @param description - Description for a key chain without one.
     * @returns The ID of the key chain that holds the certificate.
     */
    async store(
        tenantId: string,
        keyId: string,
        issued: IssuedCertificate,
        description: string,
    ): Promise<string> {
        try {
            const chain = await this.issuingCa.chainFor(
                tenantId,
                issued.value,
                issued.registrar,
            );
            const certId = await this.certService.addCertificate(tenantId, {
                crt: chain,
                keyId,
                defaultDescription: description,
            });
            this.logger.log(
                `[${tenantId}] Stored ${issued.registrar} access certificate ${issued.id} in key chain ${certId}`,
            );
            return certId;
        } catch (error) {
            await revokeUnstored(this.logger, tenantId, issued, "access");
            throw error;
        }
    }
}
