/** Settings of the OpenID Provider, read once in the module. */
export interface OidcProviderSettings {
    /** Public base URL of EUDIPLO, without trailing slash. */
    publicUrl: string;
}

export const OIDC_PROVIDER_SETTINGS = Symbol("OIDC_PROVIDER_SETTINGS");

/** Issuer of a tenant's OpenID Provider; every endpoint lives below it. */
export function oidcIssuer(publicUrl: string, tenantId: string): string {
    return `${publicUrl}/verifiers/${encodeURIComponent(tenantId)}/oidc`;
}
