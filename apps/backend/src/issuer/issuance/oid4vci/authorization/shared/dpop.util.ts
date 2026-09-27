import { createHash } from "node:crypto";
import { decodeProtectedHeader } from "jose";

/**
 * Freshness window for DPoP proofs (RFC 9449 Section 11.1), based on `iat`.
 */
export const DPOP_PROOF_FRESHNESS = {
    maxProofAgeSeconds: 300,
    allowedClockSkewSeconds: 60,
} as const;

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
