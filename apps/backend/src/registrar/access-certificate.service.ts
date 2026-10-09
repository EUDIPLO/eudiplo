import { X509Certificate } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CertService } from "../crypto/key/cert/cert.service.js";
import { KeyChainService } from "../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../crypto/key/types/key-usage-type.js";
import type { Client } from "./generated/client/index.js";
import {
    accessCertificateControllerAccessCertificates,
    accessCertificateControllerRegister,
} from "./generated/index.js";
import { RegistrarAuthService } from "./registrar-auth.service.js";
import type { CreateAccessCertificate } from "./schemas/registrar.schema.js";

/**
 * Handles creation of access certificates via the registrar API and their
 * subsequent storage in the local certificate store.
 */
@Injectable()
export class AccessCertificateService {
    private readonly logger = new Logger(AccessCertificateService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly authService: RegistrarAuthService,
        private readonly certService: CertService,
        private readonly keyChainService: KeyChainService,
    ) {}

    /**
     * Create an access certificate for a key.
     * Fetches the relying party from the registrar, registers the certificate,
     * and stores it in EUDIPLO's local certificate store.
     *
     * @param tenantId - The tenant ID
     * @param dto - The access certificate creation data
     * @returns The registrar cert ID, local cert ID, and certificate PEM
     */
    async createAccessCertificate(
        tenantId: string,
        dto: CreateAccessCertificate,
    ): Promise<{ id: string; certId: string; crt: string }> {
        const client = await this.authService.getClient(tenantId);
        const relyingPartyId =
            await this.authService.getRelyingPartyId(tenantId);

        const csr = await this.keyChainService.createCertificateSigningRequest(
            tenantId,
            dto.keyId,
        );

        const res = await accessCertificateControllerRegister({
            client,
            body: {
                displayName: `Access certificate for ${dto.keyId}`,
                csr,
                rpId: relyingPartyId,
            },
        });

        if (res.error) {
            console.log(res.error);
            this.logger.error(
                { error: res.error },
                `[${tenantId}] Failed to create access certificate`,
            );
            throw new BadRequestException(
                "Failed to create access certificate",
            );
        }

        const { id, crt } = res.data!;

        const certId = await this.certService.addCertificate(tenantId, {
            crt: [crt],
            keyId: dto.keyId,
            description: `Access certificate from registrar (ID: ${id})`,
        });

        this.logger.log(
            `[${tenantId}] Created access certificate with ID: ${id}, stored as ${certId}`,
        );

        return { id, certId, crt };
    }

    /**
     * Find the registrar id of the access certificate held by an access key
     * chain, so a registration certificate can be linked to the access
     * certificate that signs requests. The link is optional at the registrar:
     * when the key chain is missing, its certificate was not issued by the
     * registrar or the registrar cannot be queried, no id is returned.
     *
     * @param tenantId - The tenant ID
     * @param client - Authenticated registrar client
     * @param relyingPartyId - The relying party at the registrar
     * @param accessKeyChainId - Access key chain to match; the tenant's default access key chain when omitted
     * @returns The registrar id of the matching active access certificate, if any
     */
    async findRegistrarAccessCertificateId(
        tenantId: string,
        client: Client,
        relyingPartyId: string,
        accessKeyChainId?: string,
    ): Promise<string | undefined> {
        const cert = await this.certService
            .find({
                tenantId,
                type: KeyUsageType.Access,
                keyId: accessKeyChainId,
                skipValidation: true,
            })
            .catch(() => undefined);
        if (!cert) {
            this.logger.warn(
                `[${tenantId}] No access key chain found; the registration certificate is not linked to an access certificate`,
            );
            return undefined;
        }
        const fingerprint = new X509Certificate(cert.crt[0]).fingerprint256;

        const res = await accessCertificateControllerAccessCertificates({
            client,
            query: { rp: relyingPartyId },
        });
        if (res.error) {
            this.logger.warn(
                { error: res.error },
                `[${tenantId}] Failed to fetch access certificates; the registration certificate is not linked to an access certificate`,
            );
            return undefined;
        }

        const match = res.data?.find(
            (entry) =>
                entry.revoked == null &&
                new X509Certificate(entry.certificate).fingerprint256 ===
                    fingerprint,
        );
        if (!match) {
            this.logger.warn(
                `[${tenantId}] The certificate of access key chain '${cert.keyId}' is not an active access certificate at the registrar; the registration certificate is not linked to an access certificate`,
            );
        }
        return match?.id;
    }
}
