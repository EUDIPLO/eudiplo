import { OAuthError } from "./oauth-error.js";

/** RFC 9126 Section 2.2: lifetime of a PAR `request_uri`. */
export const PAR_REQUEST_URI_LIFETIME_SECONDS = 60;

/** FAPI 2.0 SP 5.3.2.1: authorization codes live at most 60 seconds. */
export const AUTHORIZATION_CODE_LIFETIME_SECONDS = 60;

/** Parameters of a pushed authorization request that the rules below check. */
export interface PushedAuthorizationParameters {
    request_uri?: string;
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    code_challenge?: string;
    code_challenge_method?: string;
}

/** Enforce the FAPI 2.0 / HAIP requirements on a pushed authorization request. */
export function assertValidPushedAuthorizationRequest(
    body: PushedAuthorizationParameters,
): void {
    if (body.request_uri) {
        throw new OAuthError(
            "invalid_request",
            "The request_uri parameter must not be sent to the PAR endpoint",
        );
    }
    if (body.response_type !== "code") {
        throw new OAuthError(
            "unsupported_response_type",
            "Only response_type 'code' is supported",
        );
    }
    if (!body.client_id) {
        throw new OAuthError(
            "invalid_request",
            "Missing required parameter: client_id",
        );
    }
    if (!body.redirect_uri) {
        throw new OAuthError(
            "invalid_request",
            "Missing required parameter: redirect_uri",
        );
    }
    if (!body.code_challenge) {
        throw new OAuthError(
            "invalid_request",
            "Missing required parameter: code_challenge",
        );
    }
    if (body.code_challenge_method !== "S256") {
        throw new OAuthError(
            "invalid_request",
            "Only code_challenge_method 'S256' is supported",
        );
    }
}

/**
 * Build the redirect back to the client, preserving any query component of
 * the registered redirect_uri (RFC 6749 Section 3.1.2).
 */
export function buildAuthorizationResponseUrl(
    redirectUri: string,
    params: Record<string, string | undefined>,
): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            url.searchParams.set(key, value);
        }
    }
    return url.toString();
}
