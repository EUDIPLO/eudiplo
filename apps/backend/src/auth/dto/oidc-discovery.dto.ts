/**
 * Data Transfer Object for OIDC Discovery Response.
 * Based on OpenID Connect Discovery 1.0 specification.
 */
export interface OidcDiscoveryDto {
    /**
     * URL using the https scheme with no query or fragment component that the OP asserts as its Issuer Identifier.
     */
    issuer: string;

    /**
     * Public client ID for the Angular UI (Authorization Code + PKCE). Only present with Keycloak (`OIDC_PROVIDER=keycloak`).
     */
    ui_client_id?: string;

    /**
     * URL of the OP's OAuth 2.0 Authorization Endpoint.
     */
    authorization_endpoint?: string;

    /**
     * URL of the OP's OAuth 2.0 Token Endpoint.
     */
    token_endpoint: string;

    /**
     * URL of the OP's UserInfo Endpoint.
     */
    userinfo_endpoint?: string;

    /**
     * URL of the OP's JSON Web Key Set document.
     */
    jwks_uri: string;

    /**
     * URL of the OP's Dynamic Client Registration Endpoint.
     */
    registration_endpoint?: string;

    /**
     * JSON array containing a list of the OAuth 2.0 scope values that this server supports.
     */
    scopes_supported?: string[];

    /**
     * JSON array containing a list of the OAuth 2.0 response_type values that this OP supports.
     */
    response_types_supported: string[];

    /**
     * JSON array containing a list of the OAuth 2.0 response_mode values that this OP supports.
     */
    response_modes_supported?: string[];

    /**
     * JSON array containing a list of the OAuth 2.0 Grant Type values that this OP supports.
     */
    grant_types_supported?: string[];

    /**
     * JSON array containing a list of the Authentication Context Class References that this OP supports.
     */
    acr_values_supported?: string[];

    /**
     * JSON array containing a list of the Subject Identifier types that this OP supports.
     */
    subject_types_supported: string[];

    /**
     * JSON array containing a list of the JWS signing algorithms supported by the OP for the ID Token.
     */
    id_token_signing_alg_values_supported: string[];

    /**
     * JSON array containing a list of the JWE encryption algorithms supported by the OP for the ID Token.
     */
    id_token_encryption_alg_values_supported?: string[];

    /**
     * JSON array containing a list of the JWE encryption methods supported by the OP for the ID Token.
     */
    id_token_encryption_enc_values_supported?: string[];

    /**
     * JSON array containing a list of the JWS signing algorithms supported by the OP for UserInfo Responses.
     */
    userinfo_signing_alg_values_supported?: string[];

    /**
     * JSON array containing a list of the JWE encryption algorithms supported by the OP for UserInfo Responses.
     */
    userinfo_encryption_alg_values_supported?: string[];

    /**
     * JSON array containing a list of the JWE encryption methods supported by the OP for UserInfo Responses.
     */
    userinfo_encryption_enc_values_supported?: string[];

    /**
     * JSON array containing a list of the JWS signing algorithms supported by the OP for Request Objects.
     */
    request_object_signing_alg_values_supported?: string[];

    /**
     * JSON array containing a list of the JWE encryption algorithms supported by the OP for Request Objects.
     */
    request_object_encryption_alg_values_supported?: string[];

    /**
     * JSON array containing a list of the JWE encryption methods supported by the OP for Request Objects.
     */
    request_object_encryption_enc_values_supported?: string[];

    /**
     * JSON array containing a list of Client Authentication methods supported by this Token Endpoint.
     */
    token_endpoint_auth_methods_supported?: string[];

    /**
     * JSON array containing a list of the JWS signing algorithms supported by the Token Endpoint for the signature on the JWT used to authenticate the Client at the Token Endpoint for the private_key_jwt and client_secret_jwt authentication methods.
     */
    token_endpoint_auth_signing_alg_values_supported?: string[];

    /**
     * JSON array containing a list of the display parameter values that the OpenID Provider supports.
     */
    display_values_supported?: string[];

    /**
     * JSON array containing a list of the Claim Types that the OpenID Provider supports.
     */
    claim_types_supported?: string[];

    /**
     * JSON array containing a list of the Claim Names of the Claims that the OpenID Provider MAY be able to supply values for.
     */
    claims_supported?: string[];

    /**
     * URL of a page containing human-readable information that developers might want or need to know when using the OpenID Provider.
     */
    service_documentation?: string;

    /**
     * Languages and scripts supported for values in Claims being returned.
     */
    claims_locales_supported?: string[];

    /**
     * Languages and scripts supported for the user interface.
     */
    ui_locales_supported?: string[];

    /**
     * Boolean value specifying whether the OP supports use of the claims parameter.
     */
    claims_parameter_supported?: boolean;

    /**
     * Boolean value specifying whether the OP supports use of the request parameter.
     */
    request_parameter_supported?: boolean;

    /**
     * Boolean value specifying whether the OP supports use of the request_uri parameter.
     */
    request_uri_parameter_supported?: boolean;

    /**
     * Boolean value specifying whether the OP requires any request_uri values used to be pre-registered.
     */
    require_request_uri_registration?: boolean;

    /**
     * URL that the OpenID Provider provides to the person registering the Client to read about the OP's requirements on how the Relying Party can use the data provided by the OP.
     */
    op_policy_uri?: string;

    /**
     * URL that the OpenID Provider provides to the person registering the Client to read about OpenID Provider's terms of service.
     */
    op_tos_uri?: string;
}
