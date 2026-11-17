/**
 * Error codes of the OpenID Connect provider: RFC 6749 Sections 4.1.2.1 and
 * 5.2, RFC 9126 Section 2.3, OpenID Connect Core 1.0 Section 3.1.2.6 and
 * RFC 9101 Section 6.2 (`request_not_supported`).
 */
export type OidcErrorCode =
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type"
    | "unsupported_response_type"
    | "invalid_scope"
    | "invalid_request_uri"
    | "access_denied"
    | "login_required"
    | "request_not_supported"
    | "server_error";

interface OidcErrorOptions {
    /**
     * The client could not be authenticated: the token and pushed
     * authorization request endpoints answer with HTTP 401.
     */
    clientAuthenticationFailed?: boolean;
    /**
     * Where the error may be sent at the authorization endpoint: the
     * validated redirect URI with the client's `state`. Without it, the error
     * is shown to the user instead (RFC 6749 Section 4.1.2.1).
     */
    redirect?: { redirectUri: string; state?: string | null };
    cause?: unknown;
}

/** Transport-neutral error; inbound adapters map it to their response. */
export class OidcError extends Error {
    readonly clientAuthenticationFailed: boolean;
    readonly redirect?: { redirectUri: string; state?: string | null };

    constructor(
        readonly code: OidcErrorCode,
        readonly description: string,
        options: OidcErrorOptions = {},
    ) {
        super(description, { cause: options.cause });
        this.name = "OidcError";
        this.clientAuthenticationFailed =
            options.clientAuthenticationFailed ?? false;
        this.redirect = options.redirect;
    }

    /** The same error, to be sent to the validated redirect URI. */
    redirectTo(redirectUri: string, state?: string | null): OidcError {
        return new OidcError(this.code, this.description, {
            redirect: { redirectUri, state },
            cause: this.cause,
        });
    }
}

/** A sign-in the browser cannot continue, shown on a page of EUDIPLO. */
export class SignInNotUsable extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SignInNotUsable";
    }
}
