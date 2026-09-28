import {
    authorizationCodeGrantIdentifier,
    preAuthorizedCodeGrantIdentifier,
    refreshTokenGrantIdentifier,
} from "@openid4vc/oauth2";
import { OAuthError } from "./oauth-error.js";

type TokenErrorCode =
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "invalid_tx_code"
    | "invalid_dpop_proof";

/**
 * Map an error code reported by the OAuth library to an OAuth 2.0 token error
 * code (OID4VCI Section 6.3):
 * - `invalid_tx_code`: wrong transaction code in the Pre-Authorized Code Flow
 * - `invalid_grant`: wrong or expired pre-authorized code
 * - `invalid_request`: anything else, including a missing code
 */
export function toTokenErrorCode(
    errorCode: string | undefined,
): TokenErrorCode {
    if (!errorCode) {
        return "invalid_request";
    }
    if (
        errorCode === "invalid_grant" ||
        errorCode === "invalid_client" ||
        errorCode === "invalid_request" ||
        errorCode === "invalid_tx_code" ||
        errorCode === "invalid_dpop_proof"
    ) {
        return errorCode;
    }
    if (errorCode.includes("tx_code") || errorCode.includes("transaction")) {
        return "invalid_tx_code";
    }
    if (
        errorCode.includes("pre-authorized") ||
        errorCode.includes("pre_authorized")
    ) {
        return "invalid_grant";
    }
    return "invalid_request";
}

const nonEmpty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;

/**
 * Best human-readable description of an error thrown by the OAuth library:
 * `errorResponse.error_description`, `error_description`, `message`, then
 * `cause.message`.
 */
export function describeLibraryError(error: unknown): string | undefined {
    if (nonEmpty(error)) {
        return error;
    }
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const candidate = error as {
        error_description?: unknown;
        errorResponse?: { error_description?: unknown };
        message?: unknown;
        cause?: { message?: unknown };
    };
    if (nonEmpty(candidate.errorResponse?.error_description)) {
        return candidate.errorResponse.error_description;
    }
    if (nonEmpty(candidate.error_description)) {
        return candidate.error_description;
    }
    if (nonEmpty(candidate.message)) {
        return candidate.message;
    }
    if (nonEmpty(candidate.cause?.message)) {
        return candidate.cause.message;
    }
    return undefined;
}

/** Description for a token request the OAuth library could not parse. */
export function describeMalformedTokenRequest(body: unknown): string {
    if (!body || typeof body !== "object") {
        return "Malformed token request body";
    }
    const tokenRequest = body as Record<string, unknown>;
    const grantType =
        typeof tokenRequest.grant_type === "string"
            ? tokenRequest.grant_type
            : undefined;
    if (!grantType) {
        return "Missing required parameter: grant_type";
    }
    if (
        grantType === authorizationCodeGrantIdentifier &&
        typeof tokenRequest.code !== "string"
    ) {
        return "Missing required parameter: code";
    }
    if (
        grantType === preAuthorizedCodeGrantIdentifier &&
        typeof tokenRequest["pre-authorized_code"] !== "string"
    ) {
        return "Missing required parameter: pre-authorized_code";
    }
    if (
        grantType === refreshTokenGrantIdentifier &&
        typeof tokenRequest.refresh_token !== "string"
    ) {
        return "Missing required parameter: refresh_token";
    }
    return `Invalid token request for grant_type: ${grantType}`;
}

/**
 * Convert an error thrown by the OAuth library's verification into an
 * {@link OAuthError}, using `errorResponse.error` as the error code.
 */
export function oauthErrorFromLibrary(error: unknown): OAuthError {
    if (error instanceof OAuthError) {
        return error;
    }
    const errorCode = (error as { errorResponse?: { error?: string } })
        ?.errorResponse?.error;
    return new OAuthError(
        toTokenErrorCode(errorCode),
        describeLibraryError(error),
    );
}
