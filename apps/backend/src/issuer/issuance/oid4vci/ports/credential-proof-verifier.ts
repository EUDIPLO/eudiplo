import type { Jwk } from "@openid4vc/oauth2";
import type { TrustListRef } from "../../../../trust/types.js";
export type IssuanceProofType = "jwt" | "attestation";
export interface PreparedCredentialProofVerifier {
    verify(proof: string, type: IssuanceProofType): Promise<Jwk[]>;
}
export interface CredentialProofVerifier {
    prepare(
        tenantId: string,
        trustLists: TrustListRef[],
    ): Promise<PreparedCredentialProofVerifier>;
}
export const CREDENTIAL_PROOF_VERIFIER = Symbol("CREDENTIAL_PROOF_VERIFIER");
