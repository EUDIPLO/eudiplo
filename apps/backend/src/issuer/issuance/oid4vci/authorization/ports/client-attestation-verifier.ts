import type {
    RevocationCheckMode,
    TrustListRef,
} from "../../../../../trust/types.js";

export interface ClientAttestation {
    clientAttestationJwt: string;
    /** Absent for the DPoP-bound `attest_jwt_client_auth_dpop` method. */
    clientAttestationPopJwt?: string;
}

/**
 * Verifies OAuth 2.0 Attestation-Based Client Authentication (wallet
 * attestation). Throws when a required attestation is missing or when a
 * presented attestation is invalid or not trusted.
 *
 * The error's message names no URL or host of the server's configuration,
 * such as a trust list URL, so the built-in token endpoint returns it to the
 * wallet. A server-side failure, such as trust lists that cannot be loaded,
 * has a fixed message and its reason as `cause`, for the log
 * (`clientAttestationLogDetail`).
 */
export interface ClientAttestationVerifier {
    verify(
        tenantId: string,
        attestation: ClientAttestation | undefined,
        expectedAudience: string,
        required: boolean,
        trustLists: TrustListRef[],
        statusCheckMode: RevocationCheckMode,
    ): Promise<void>;
}

export const CLIENT_ATTESTATION_VERIFIER = Symbol(
    "CLIENT_ATTESTATION_VERIFIER",
);
