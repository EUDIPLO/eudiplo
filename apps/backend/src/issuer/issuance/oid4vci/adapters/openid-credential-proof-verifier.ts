import type { Jwk } from "@openid4vc/oauth2";
import { decodeJwt } from "jose";
import type { TrustStoreService } from "../../../../trust/trust-store.service.js";
import type { TrustListRef } from "../../../../trust/types.js";
import type { X509ValidationService } from "../../../../trust/x509-validation.service.js";
import {
    validateAttestationProofTrust,
    validateJwtProofAttestationTrust,
} from "../attestation-proof-trust.util.js";
import type {
    CredentialProofVerifier,
    IssuanceProofType,
} from "../ports/credential-proof-verifier.js";
import type { Oid4vciProtocolMetadata } from "./oid4vci-protocol-metadata.js";

export class OpenIdCredentialProofVerifier implements CredentialProofVerifier {
    constructor(
        private readonly metadata: Oid4vciProtocolMetadata,
        private readonly trustStoreService: TrustStoreService,
        private readonly x509ValidationService: X509ValidationService,
    ) {}
    async prepare(tenantId: string, trustLists: TrustListRef[]) {
        const issuer = this.metadata.getIssuer(tenantId);
        const issuerMetadata = await this.metadata.issuerMetadata(tenantId);
        const trust = {
            tenantId,
            trustStoreService: this.trustStoreService,
            x509ValidationService: this.x509ValidationService,
        };
        return {
            verify: async (
                proof: string,
                type: IssuanceProofType,
            ): Promise<Jwk[]> => {
                const expectedNonce = decodeJwt(proof).nonce as string;
                if (type === "jwt") {
                    const verified =
                        await issuer.verifyCredentialRequestJwtProof({
                            expectedNonce,
                            issuerMetadata,
                            jwt: proof,
                        });
                    await validateJwtProofAttestationTrust(
                        proof,
                        trustLists,
                        trust,
                    );
                    return [verified.signer.publicJwk];
                }
                const verified =
                    await issuer.verifyCredentialRequestAttestationProof({
                        expectedNonce,
                        issuerMetadata,
                        keyAttestationJwt: proof,
                    });
                await validateAttestationProofTrust(proof, trustLists, trust);
                return verified.payload.attested_keys as Jwk[];
            },
        };
    }
}
