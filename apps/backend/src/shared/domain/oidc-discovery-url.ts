/**
 * URL of the OpenID Connect discovery document of `issuer` (OpenID Connect
 * Discovery 1.0, section 4): `/.well-known/openid-configuration` appended to
 * the issuer without its trailing slash. Issuers such as Authentik's end in
 * a slash, which plain concatenation would double.
 */
export function oidcDiscoveryUrl(issuer: string): string {
    return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
}
