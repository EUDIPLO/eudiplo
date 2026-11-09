import type {
    RevocationCheckMode,
    TrustListRef,
} from "../../../../trust/types.js";
import type { VerifiedCredentialProof } from "../domain/key-attestation-requirements.js";
export type IssuanceProofType = "jwt" | "attestation";
interface PreparedCredentialProofVerifier {
    /**
     * Verify a key proof, including the signature, the provider trust and
     * the status of a key attestation conveyed with it.
     */
    verify(
        proof: string,
        type: IssuanceProofType,
    ): Promise<VerifiedCredentialProof>;
}
export interface CredentialProofVerifier {
    /**
     * @param statusCheckMode How the status list of a key attestation is
     * checked: strict, best_effort or disabled
     */
    prepare(
        tenantId: string,
        trustLists: TrustListRef[],
        statusCheckMode: RevocationCheckMode,
    ): Promise<PreparedCredentialProofVerifier>;
}
export const CREDENTIAL_PROOF_VERIFIER = Symbol("CREDENTIAL_PROOF_VERIFIER");
