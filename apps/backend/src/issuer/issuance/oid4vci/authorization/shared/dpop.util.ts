import {
    type AuthorizationServerMetadata,
    type CallbackContext,
    type RequestLike,
    type VerifyResourceRequestOptions,
    verifyAuthorizationRequest,
} from "@openid4vc/oauth2";
import { decodeProtectedHeader } from "jose";
import type { DpopProofReplayRegistry } from "../../ports/dpop-proof-replay-registry.js";
import { OAuthError } from "../domain/oauth-error.js";
import { describeLibraryError } from "../domain/token-errors.js";

/**
 * Freshness window for DPoP proofs (RFC 9449 Section 11.1), based on `iat`.
 */
const DPOP_PROOF_FRESHNESS = {
    maxProofAgeSeconds: 300,
    allowedClockSkewSeconds: 60,
} as const;

type DpopProofVerificationOptions = NonNullable<
    VerifyResourceRequestOptions["dpop"]
>;

/**
 * Last moment a proof issued at `iat` (seconds) passes the freshness check:
 * `iat` plus the maximum age plus the allowed clock skew. Without `iat` the
 * window starts at `now`.
 */
export function dpopProofExpiresAt(iat: number | undefined, now: Date): Date {
    const windowMs =
        (DPOP_PROOF_FRESHNESS.maxProofAgeSeconds +
            DPOP_PROOF_FRESHNESS.allowedClockSkewSeconds) *
        1000;
    const issuedAtMs =
        typeof iat === "number" && Number.isFinite(iat)
            ? iat * 1000
            : now.getTime();
    return new Date(issuedAtMs + windowMs);
}

/**
 * DPoP proof checks passed to the OAuth library at every endpoint that
 * verifies a proof: the freshness window and single use of each `jti` per
 * key (RFC 9449 Section 11.1). A replayed proof makes the library reject the
 * request.
 */
export function dpopProofVerification(
    replayRegistry: DpopProofReplayRegistry,
): Required<
    Pick<
        DpopProofVerificationOptions,
        "maxProofAgeSeconds" | "allowedClockSkewSeconds" | "assertJtiUniqueness"
    >
> {
    return {
        ...DPOP_PROOF_FRESHNESS,
        assertJtiUniqueness: ({ payload, jwkThumbprint, now }) =>
            replayRegistry.register(
                jwkThumbprint,
                payload.jti,
                dpopProofExpiresAt(payload.iat, now),
            ),
    };
}

/** JWK members only present in private or symmetric keys (RFC 7518 Section 6). */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

export interface DpopProof {
    /** Compact DPoP proof from the `DPoP` request header, if one was sent. */
    jwt?: string;
    /** Method and URL of the endpoint the proof must be bound to (`htm`, `htu`). */
    request: Pick<RequestLike, "method" | "url">;
    /**
     * Metadata of the authorization server. Only proofs signed with an
     * algorithm from `dpop_signing_alg_values_supported` are accepted.
     */
    authorizationServerMetadata: AuthorizationServerMetadata;
    /** RFC 7638 thumbprint of the key the grant is bound to, if any. */
    expectedJwkThumbprint?: string;
    /** Reject a request without a proof. */
    required?: boolean;
}

/**
 * Verify a DPoP proof (RFC 9449 Section 4.3) with the OAuth library: `typ`,
 * `alg`, the signature with the public `jwk` of its header, `htm`, `htu`,
 * `iat` freshness and single use of `jti` (Section 11.1).
 *
 * Returns the RFC 7638 thumbprint of the proof key, or `undefined` when no
 * proof was sent and none is required.
 *
 * @throws {OAuthError} `invalid_dpop_proof`
 */
export async function verifyDpopProof(
    proof: DpopProof,
    callbacks: Pick<CallbackContext, "hash" | "verifyJwt">,
    replayRegistry: DpopProofReplayRegistry,
): Promise<string | undefined> {
    if (!proof.jwt) {
        if (proof.required) {
            throw new OAuthError(
                "invalid_dpop_proof",
                "Missing required DPoP proof",
            );
        }
        return undefined;
    }

    let jwkThumbprint: string | undefined;
    try {
        const { jwk } = decodeProtectedHeader(proof.jwt);
        if (jwk && PRIVATE_JWK_MEMBERS.some((member) => member in jwk)) {
            throw new OAuthError(
                "invalid_dpop_proof",
                "The DPoP proof jwk must not contain a private key",
            );
        }
        const { dpop } = await verifyAuthorizationRequest({
            authorizationRequest: {},
            authorizationServerMetadata: proof.authorizationServerMetadata,
            request: { ...proof.request, headers: new Headers() },
            dpop: {
                jwt: proof.jwt,
                // Without advertised algorithms no proof is accepted.
                allowedSigningAlgs:
                    proof.authorizationServerMetadata
                        .dpop_signing_alg_values_supported ?? [],
                ...dpopProofVerification(replayRegistry),
            },
            callbacks,
        });
        jwkThumbprint = dpop?.jwkThumbprint;
    } catch (error) {
        if (error instanceof OAuthError) {
            throw error;
        }
        // The library describes the failed check; other errors stay internal.
        const description = (error as { errorResponse?: unknown })
            ?.errorResponse
            ? describeLibraryError(error)
            : undefined;
        throw new OAuthError(
            "invalid_dpop_proof",
            description ?? "Invalid DPoP proof",
            { cause: error },
        );
    }

    if (
        !jwkThumbprint ||
        (proof.expectedJwkThumbprint &&
            proof.expectedJwkThumbprint !== jwkThumbprint)
    ) {
        throw new OAuthError(
            "invalid_dpop_proof",
            "The DPoP proof is not signed with the key bound to this authorization",
        );
    }
    return jwkThumbprint;
}
