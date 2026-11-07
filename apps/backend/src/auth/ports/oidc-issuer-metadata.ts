export const OIDC_ISSUER_METADATA = Symbol("OIDC_ISSUER_METADATA");

/**
 * The values of the identity provider's discovery document that EUDIPLO uses
 * with `OIDC_PROVIDER=generic`. `null` in the other modes.
 */
export interface OidcIssuerMetadata {
    issuer: string;
    jwks_uri: string;
    token_endpoint: string;
}
