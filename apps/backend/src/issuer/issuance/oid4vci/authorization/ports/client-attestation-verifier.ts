import type { TrustListRef } from "../../../../../trust/types.js";

export interface ClientAttestation {
    clientAttestationJwt: string;
    /** Absent for the DPoP-bound `attest_jwt_client_auth_dpop` method. */
    clientAttestationPopJwt?: string;
}

/**
 * Verifies OAuth 2.0 Attestation-Based Client Authentication (wallet
 * attestation). Throws when a required attestation is missing or when a
 * presented attestation is invalid or not trusted.
 */
export interface ClientAttestationVerifier {
    verify(
        tenantId: string,
        attestation: ClientAttestation | undefined,
        expectedAudience: string,
        required: boolean,
        trustLists: TrustListRef[],
    ): Promise<void>;
}

export const CLIENT_ATTESTATION_VERIFIER = Symbol(
    "CLIENT_ATTESTATION_VERIFIER",
);
