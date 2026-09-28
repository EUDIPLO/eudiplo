/**
 * Identity context from authorization server token (internal or external AS).
 */

export interface AuthorizationIdentity {
    /**
     * The issuer (iss) of the authorization server
     */
    iss: string;
    /**
     * The subject (sub) from the AS token - user identifier
     */
    sub: string;
    /**
     * Additional claims from the access token
     */
    token_claims: Record<string, unknown>;
}
