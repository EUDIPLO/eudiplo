import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/**
 * DTO for the authorization response containing either a VP token (success) or
 * an OAuth 2.0 error response (when wallet cannot fulfill the request).
 *
 * Per OID4VP spec section 6.2, wallets can return error responses with:
 * - error (required)
 * - error_description (optional)
 * - error_uri (optional)
 * - state (required if present in the request)
 *
 * @see https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-error-response
 */
const AuthorizationResponseSchema = z
    .object({
        response: z.string().optional(),
        sendResponse: z.boolean().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
        error_uri: z.string().optional(),
        state: z.string().optional(),
    })
    .strip();

export class AuthorizationResponse extends createZodDto(
    AuthorizationResponseSchema,
) {
    /**
     * The response string containing the authorization details (JWE-encrypted VP token).
     * Required for success responses, absent for error responses.
     */
    response?: string;

    /**
     * When set to true, the authorization response will be sent to the client.
     */
    sendResponse?: boolean;

    // OAuth 2.0 Authorization Error Response fields (per RFC 6749 section 4.1.2.1)

    /**
     * Error code indicating why the wallet could not fulfill the request.
     * Common values: invalid_request, unauthorized_client, access_denied,
     * unsupported_response_type, invalid_scope, server_error, temporarily_unavailable.
     */
    error?: string;

    /**
     * Human-readable description of the error.
     */
    error_description?: string;

    /**
     * URI with additional information about the error.
     */
    error_uri?: string;

    /**
     * State value from the authorization request (for correlation).
     */
    state?: string;
}
