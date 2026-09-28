/**
 * OAuth 2.0 error codes returned by the built-in authorization server:
 * RFC 6749 Section 5.2 (token), RFC 9126 Section 2.3 (PAR), RFC 9449 (DPoP),
 * OID4VCI Section 6.3 (`invalid_tx_code`) and RFC 9126 Section 4
 * (`invalid_request_uri` at the authorization endpoint).
 */
export type OAuthErrorCode =
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type"
    | "invalid_scope"
    | "invalid_tx_code"
    | "invalid_dpop_proof"
    | "unsupported_response_type"
    | "invalid_request_uri";

interface OAuthErrorOptions {
    /**
     * Client authentication failed at the token endpoint. The token endpoint
     * answers with HTTP 401 instead of 400 (RFC 6749 Section 5.2).
     */
    clientAuthenticationFailed?: boolean;
    /** Server-side log message; never returned to the client. */
    logDetail?: string;
    cause?: unknown;
}

/**
 * Transport-neutral OAuth error. `description` becomes `error_description`;
 * inbound adapters map the error to the HTTP response of their endpoint.
 */
export class OAuthError extends Error {
    readonly clientAuthenticationFailed: boolean;
    readonly logDetail?: string;

    constructor(
        readonly code: OAuthErrorCode,
        readonly description?: string,
        options: OAuthErrorOptions = {},
    ) {
        super(description ?? code, { cause: options.cause });
        this.name = "OAuthError";
        this.clientAuthenticationFailed =
            options.clientAuthenticationFailed ?? false;
        this.logDetail = options.logDetail;
    }
}
