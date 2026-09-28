export interface OidcDiscoveryDocument {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    userinfo_endpoint?: string;
    jwks_uri: string;
    scopes_supported?: string[];
    response_types_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
}

export const OIDC_DISCOVERY_RESOLVER = Symbol("OIDC_DISCOVERY_RESOLVER");

export interface OidcDiscoveryResolver {
    resolve(issuer: string): Promise<OidcDiscoveryDocument>;
}
