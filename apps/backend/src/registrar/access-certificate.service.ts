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
     * chain. The registrar links every registration certificate to an active
     * access certificate of the relying party, so the certificate that signs
     * requests is matched against the relying party's certificates at the
     * registrar.
     *
     * @param tenantId - The tenant ID
     * @param client - Authenticated registrar client
     * @param relyingPartyId - The relying party at the registrar
     * @param accessKeyChainId - Access key chain to match; the tenant's default access key chain when omitted
     * @returns The registrar id of the matching access certificate
     */
    async findRegistrarAccessCertificateId(
        tenantId: string,
        client: Client,
        relyingPartyId: string,
        accessKeyChainId?: string,
    ): Promise<string> {
        const cert = await this.certService.find({
            tenantId,
            type: KeyUsageType.Access,
            keyId: accessKeyChainId,
            skipValidation: true,
        });
        const fingerprint = new X509Certificate(cert.crt[0]).fingerprint256;

        const res = await accessCertificateControllerAccessCertificates({
            client,
            query: { rp: relyingPartyId },
        });
        if (res.error) {
            this.logger.error(
                { error: res.error },
                `[${tenantId}] Failed to fetch access certificates`,
            );
            throw new BadRequestException(
                "Failed to query access certificates from the registrar",
            );
        }

        const match = res.data?.find(
            (entry) =>
                entry.revoked == null &&
                new X509Certificate(entry.certificate).fingerprint256 ===
                    fingerprint,
        );
        if (!match) {
            throw new BadRequestException(
                `The certificate of access key chain '${cert.keyId}' is not an active access certificate at the registrar. Create the access certificate for this key chain via the registrar.`,
            );
        }
        return match.id;
    }
}
