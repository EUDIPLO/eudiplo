import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { checkPkce } from "../domain/pkce.js";

/** PKCE check for the chained authorization servers, mapped to their HTTP errors. */
export function verifyPkceCodeChallenge(
    codeChallenge?: string,
    codeChallengeMethod?: string,
    codeVerifier?: string,
): void {
    const result = checkPkce(codeChallenge, codeChallengeMethod, codeVerifier);
    if (result === "mismatch") {
        throw new UnauthorizedException("Invalid code_verifier");
    }
    if (result === "missing_verifier") {
        throw new BadRequestException("code_verifier is required");
    }
}
