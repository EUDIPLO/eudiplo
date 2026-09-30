import { createHash } from "node:crypto";
import { OAuthError } from "./oauth-error.js";

export type PkceCheck = "valid" | "missing_verifier" | "mismatch";

/**
 * Require PKCE with `S256` on an authorization request, as mandated by
 * HAIP 1.0 Section 4 and FAPI 2.0 SP 5.3.2.2. The `plain` method is rejected.
 */
export function assertS256CodeChallenge(
    codeChallenge: string | undefined,
    codeChallengeMethod: string | undefined,
): void {
    if (!codeChallenge) {
        throw new OAuthError(
            "invalid_request",
            "Missing required parameter: code_challenge",
        );
    }
    if (codeChallengeMethod !== "S256") {
        throw new OAuthError(
            "invalid_request",
            "Only code_challenge_method 'S256' is supported",
        );
    }
}

/**
 * Check a PKCE `code_verifier` against the stored challenge (RFC 7636 Section 4.6).
 * Without a stored challenge there is nothing to verify. `S256` hashes the
 * verifier; any other method compares it literally (`plain`).
 */
export function checkPkce(
    codeChallenge: string | undefined,
    codeChallengeMethod: string | undefined,
    codeVerifier: string | undefined,
): PkceCheck {
    if (!codeChallenge) {
        return "valid";
    }
    if (!codeVerifier) {
        return "missing_verifier";
    }
    const expectedChallenge =
        codeChallengeMethod === "S256"
            ? createHash("sha256").update(codeVerifier).digest("base64url")
            : codeVerifier;
    return expectedChallenge === codeChallenge ? "valid" : "mismatch";
}
