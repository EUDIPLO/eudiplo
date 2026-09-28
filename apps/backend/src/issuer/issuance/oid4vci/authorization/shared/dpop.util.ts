import { createHash } from "node:crypto";
import type { VerifyResourceRequestOptions } from "@openid4vc/oauth2";
import { decodeProtectedHeader } from "jose";
import type { DpopProofReplayRegistry } from "../../ports/dpop-proof-replay-registry.js";

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

/**
 * Extract DPoP JWK thumbprint from DPoP JWT.
 * Returns undefined if parsing fails or DPoP is not provided.
 */
export function extractDpopJkt(dpopJwt?: string): string | undefined {
    if (!dpopJwt) {
        return undefined;
    }
    try {
        const header = decodeProtectedHeader(dpopJwt);
        if (header.jwk) {
            // Calculate JWK thumbprint (simplified - in production use jose's calculateJwkThumbprint)
            const thumbprintInput = JSON.stringify({
                crv: header.jwk.crv,
                kty: header.jwk.kty,
                x: header.jwk.x,
                y: header.jwk.y,
            });
            return createHash("sha256")
                .update(thumbprintInput)
                .digest("base64url");
        }
    } catch {
        // Invalid DPoP JWT
    }
    return undefined;
}
