import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { OAuthError } from "../domain/oauth-error.js";
import { assertS256CodeChallenge, checkPkce } from "../domain/pkce.js";

/**
 * Require PKCE with `S256` on a pushed authorization request to the chained
 * authorization servers, mapped to their HTTP errors.
 */
export function assertPkceCodeChallenge(
    codeChallenge?: string,
    codeChallengeMethod?: string,
): void {
    try {
        assertS256CodeChallenge(codeChallenge, codeChallengeMethod);
    } catch (error) {
        if (error instanceof OAuthError) {
            throw new BadRequestException({
                error: error.code,
                error_description: error.description,
                message: error.description,
            });
        }
        throw error;
    }
}

/** PKCE check for the chained authorization servers, mapped to their HTTP errors. */
export function verifyPkceCodeChallenge(
    codeChallenge?: string,
    codeChallengeMethod?: string,
    codeVerifier?: string,
): void {
    // The authorization request is rejected without an S256 challenge, so a
    // session without one must never be redeemable.
    if (!codeChallenge || codeChallengeMethod !== "S256") {
        throw new BadRequestException("PKCE with S256 is required");
    }
    const result = checkPkce(codeChallenge, codeChallengeMethod, codeVerifier);
    if (result === "mismatch") {
        throw new UnauthorizedException("Invalid code_verifier");
    }
    if (result === "missing_verifier") {
        throw new BadRequestException("code_verifier is required");
    }
}
