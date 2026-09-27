import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Jwk } from "@openid4vc/oauth2";
import { digest, generateSalt } from "@owf/crypto";
import { JWTwithStatusListPayload } from "@owf/token-status-list";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { CertService } from "../../../../../crypto/key/cert/cert.service.js";
import { CryptoImplementationService } from "../../../../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import { KeyChainService } from "../../../../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../../../../crypto/key/types/key-usage-type.js";
import { Session } from "../../../../../session/entities/session.entity.js";
import { StatusListService } from "../../../../status-list/status-list.service.js";
import {
    CredentialConfig,
    SdJwtTrustFormat,
} from "../../entities/credential.entity.js";
import { buildDisclosureFrame } from "../../utils/index.js";
import { roundedCredentialValidity } from "../credential-time.util.js";

export interface SdJwtVcIssueOptions {
    credentialConfiguration: CredentialConfig;
    holderCnf: Jwk;
    session: Session;
    claims: Record<string, any>;
    federationEntityId?: string;
    issuanceSetId?: string;
}

/**
 * Service for issuing SD-JWT VC credentials.
 */
@Injectable()
export class SdjwtvcIssuerService {
    constructor(
        private readonly certService: CertService,
        private readonly configService: ConfigService,
        private readonly statusListService: StatusListService,
        private readonly cryptoImplementationService: CryptoImplementationService,
        private readonly keyChainService: KeyChainService,
    ) {}

    /**
     * Issues an SD-JWT VC credential.
     * @param options - The issuance options (including optional federationEntityId for federation-based trust)
     * @returns The issued SD-JWT VC credential string
     */
    async issue(options: SdJwtVcIssueOptions): Promise<string> {
        const {
            credentialConfiguration,
            holderCnf,
            session,
            claims,
            federationEntityId,
            issuanceSetId,
        } = options;

        const certificate = await this.certService.find({
            tenantId: session.tenantId,
            type: KeyUsageType.Attestation,
            keyId: credentialConfiguration.keyChainId,
        });

        const sdjwt = new SDJwtVcInstance({
            signer: await this.keyChainService.signer(
                session.tenantId,
                certificate.keyId,
            ),
            signAlg: this.cryptoImplementationService.getAlg(),
            hasher: digest,
            hashAlg: "sha-256",
            saltGenerator: generateSalt,
            loadTypeMetadataFormat: true,
        });

        // If status management is enabled, create a status entry
        let status: JWTwithStatusListPayload | undefined;
        if (credentialConfiguration.statusManagement) {
            status = await this.statusListService.createEntry(
                session,
                credentialConfiguration.id,
                credentialConfiguration,
                issuanceSetId,
            );
        }

        const { issuedAt: iat, expiresAt } = roundedCredentialValidity(
            credentialConfiguration.lifeTime ?? 0,
        );
        // Set expiration time if lifeTime is defined
        const exp = credentialConfiguration.lifeTime ? expiresAt : undefined;

        // If key binding is enabled, include the JWK in the cnf
        let cnf: { jwk: Jwk } | undefined;
        if (credentialConfiguration.keyBinding) {
            cnf = {
                jwk: holderCnf,
            };
        }

        const host = this.configService.getOrThrow<string>("PUBLIC_URL");
        const disclosureFrame =
            buildDisclosureFrame(credentialConfiguration.fields as any) ?? {};

        const vct =
            typeof credentialConfiguration.vct === "string"
                ? credentialConfiguration.vct
                : `${host}/issuers/${session.tenantId}/credentials-metadata/vct/${credentialConfiguration.id}`;

        // Federation is opt-in only; default and legacy modes use x5c.
        const trustFormat =
            credentialConfiguration.sdJwtTrustFormat ?? SdJwtTrustFormat.X5C;
        const useFederation =
            trustFormat === SdJwtTrustFormat.FEDERATION &&
            Boolean(federationEntityId);

        // Build issuer identifier
        const issuer = useFederation
            ? federationEntityId
            : `${host}/issuers/${session.tenantId}`;

        // Build header: include x5c only if not using federation
        const header: any = {
            alg: this.cryptoImplementationService.getAlg(),
        };

        if (!useFederation) {
            // Include the presented chain for verification, excluding the
            // configured trust anchor certificate.
            header.x5c = this.certService.getCertChain(certificate);
        }

        return sdjwt.issue(
            {
                iss: issuer,
                iat,
                exp,
                vct,
                cnf,
                ...claims,
                ...status,
            },
            disclosureFrame,
            {
                header,
            },
        );
    }
}
