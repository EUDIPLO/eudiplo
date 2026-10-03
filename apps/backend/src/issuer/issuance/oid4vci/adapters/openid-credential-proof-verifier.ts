import type { Jwk } from "@openid4vc/oauth2";
import { decodeJwt } from "jose";
import type { TrustStoreService } from "../../../../trust/trust-store.service.js";
import type { TrustListRef } from "../../../../trust/types.js";
import type { X509ValidationService } from "../../../../trust/x509-validation.service.js";
import type { BuildIssuerMetadata } from "../application/build-issuer-metadata.js";
import {
    validateAttestationProofTrust,
    validateJwtProofAttestationTrust,
} from "../attestation-proof-trust.util.js";
import type {
    VerifiedCredentialProof,
    VerifiedKeyAttestation,
} from "../domain/key-attestation-requirements.js";
import type { Oid4vciSdkFactory } from "../oid4vci-sdk.factory.js";
import type {
    CredentialProofVerifier,
    IssuanceProofType,
} from "../ports/credential-proof-verifier.js";

export class OpenIdCredentialProofVerifier implements CredentialProofVerifier {
    constructor(
        private readonly sdk: Oid4vciSdkFactory,
        private readonly buildIssuerMetadata: BuildIssuerMetadata,
        private readonly trustStoreService: TrustStoreService,
        private readonly x509ValidationService: X509ValidationService,
    ) {}
    async prepare(tenantId: string, trustLists: TrustListRef[]) {
        const issuer = this.sdk.issuer(tenantId);
        const issuerMetadata = await this.buildIssuerMetadata.execute(
            tenantId,
            issuer,
        );
        const trust = {
            tenantId,
            trustStoreService: this.trustStoreService,
            x509ValidationService: this.x509ValidationService,
        };
        return {
            verify: async (
                proof: string,
                type: IssuanceProofType,
            ): Promise<VerifiedCredentialProof> => {
                const expectedNonce = decodeJwt(proof).nonce as string;
                if (type === "jwt") {
                    const verified =
                        await issuer.verifyCredentialRequestJwtProof({
                            expectedNonce,
                            issuerMetadata,
                            jwt: proof,
                        });
                    // The library verified the key attestation signature and
                    // that the proof is signed with one of the attested keys.
                    await validateJwtProofAttestationTrust(
                        proof,
                        trustLists,
                        trust,
                    );
                    return {
                        holderKeys: [verified.signer.publicJwk],
                        keyAttestation: verified.keyAttestation
                            ? toVerifiedKeyAttestation(
                                  verified.keyAttestation.payload,
                              )
                            : undefined,
                    };
                }
                const verified =
                    await issuer.verifyCredentialRequestAttestationProof({
                        expectedNonce,
                        issuerMetadata,
                        keyAttestationJwt: proof,
                    });
                await validateAttestationProofTrust(proof, trustLists, trust);
                const keyAttestation = toVerifiedKeyAttestation(
                    verified.payload,
                );
                return {
                    holderKeys: keyAttestation.attestedKeys,
                    keyAttestation,
                };
            },
        };
    }
}

function toVerifiedKeyAttestation(payload: {
    attested_keys: unknown[];
    key_storage?: string[];
    user_authentication?: string[];
}): VerifiedKeyAttestation {
    return {
        attestedKeys: payload.attested_keys as Jwk[],
        keyStorage: payload.key_storage,
        userAuthentication: payload.user_authentication,
    };
}
