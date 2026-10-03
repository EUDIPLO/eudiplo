import type { TrustListRef } from "../../../../trust/types.js";
import type { VerifiedCredentialProof } from "../domain/key-attestation-requirements.js";
export type IssuanceProofType = "jwt" | "attestation";
interface PreparedCredentialProofVerifier {
    /**
     * Verify a key proof, including the signature and the provider trust of
     * a key attestation conveyed with it.
     */
    verify(
        proof: string,
        type: IssuanceProofType,
    ): Promise<VerifiedCredentialProof>;
}
export interface CredentialProofVerifier {
    prepare(
        tenantId: string,
        trustLists: TrustListRef[],
    ): Promise<PreparedCredentialProofVerifier>;
}
export const CREDENTIAL_PROOF_VERIFIER = Symbol("CREDENTIAL_PROOF_VERIFIER");
