import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * OAuth 2.0 Token Error Codes as defined in:
 * - RFC 6749 Section 5.2 (https://www.rfc-editor.org/rfc/rfc6749#section-5.2)
 * - OID4VCI Section 6.3 (https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html#name-token-error-response)
 *
 * OID4VCI specific clarifications:
 * - `invalid_request`:
 *   - The Authorization Server does not expect a Transaction Code in the Pre-Authorized Code Flow but the Client provides one.
 *   - The Authorization Server expects a Transaction Code in the Pre-Authorized Code Flow but the Client does not provide one.
 * - `invalid_grant`:
 *   - The End-User provides the wrong Pre-Authorized Code or the Pre-Authorized Code has expired.
 * - `invalid_tx_code`:
 *   - The Authorization Server expects a Transaction Code in the Pre-Authorized Code Flow but the Client provides the wrong Transaction Code.
 * - `invalid_client`:
 *   - The Client tried to send a Token Request with a Pre-Authorized Code without a Client ID but the Authorization Server does not support anonymous access.
 */
export type TokenErrorCode =
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type"
    | "invalid_scope"
    // OID4VCI Section 6.3: returned when the Client provides the wrong
    // Transaction Code in the Pre-Authorized Code Flow.
    | "invalid_tx_code"
    // RFC 9449 Section 5 / 7.1: invalid DPoP proof at token or PAR endpoint.
    | "invalid_dpop_proof"
    // RFC 9126 Section 2.3: PAR endpoint uses authorization error codes.
    | "unsupported_response_type";

/**
 * Exception for OAuth 2.0 Token Error responses.
 *
 * According to RFC 6749 Section 5.2 and OID4VCI Section 6.3, the response
 * MUST use HTTP status code 400 and contain `error` and optionally `error_description`.
 *
 * Error codes from RFC 6749:
 * - `invalid_request`: The request is missing a required parameter, includes an
 *   unsupported parameter value (other than grant type), repeats a parameter,
 *   includes multiple credentials, utilizes more than one mechanism for
 *   authenticating the client, or is otherwise malformed.
 * - `invalid_client`: Client authentication failed (e.g., unknown client, no
 *   client authentication included, or unsupported authentication method).
 * - `invalid_grant`: The provided authorization grant (e.g., authorization
 *   code, resource owner credentials) or refresh token is invalid, expired,
 *   revoked, does not match the redirection URI used in the authorization
 *   request, or was issued to another client.
 * - `unauthorized_client`: The authenticated client is not authorized to use
 *   this authorization grant type.
 * - `unsupported_grant_type`: The authorization grant type is not supported
 *   by the authorization server.
 * - `invalid_scope`: The requested scope is invalid, unknown, malformed, or
 *   exceeds the scope granted by the resource owner.
 */
export class TokenErrorException extends HttpException {
    constructor(
        error: TokenErrorCode,
        errorDescription?: string,
        status: HttpStatus = HttpStatus.BAD_REQUEST,
    ) {
        const response: {
            error: TokenErrorCode;
            error_description?: string;
        } = {
            error,
        };
        const sanitized = errorDescription
            ? sanitizeErrorDescription(errorDescription)
            : undefined;
        if (sanitized) {
            response.error_description = sanitized;
        }
        super(response, status);
    }
}

/**
 * RFC 6749 Section 5.2: `error_description` MUST only contain %x20-21 / %x23-5B / %x5D-7E.
 */
function sanitizeErrorDescription(description: string): string {
    return description
        .replaceAll(/[^\x20-\x21\x23-\x5B\x5D-\x7E]+/g, " ")
        .replaceAll(/\s+/g, " ")
        .trim();
}
