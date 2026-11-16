import type { Oauth2AuthorizationServer } from "@openid4vc/oauth2";

/**
 * Creates the OAuth library's authorization server with the tenant's crypto
 * callbacks. `sessionId` scopes the callbacks to an issuance session.
 * `keyChainIds` maps a signer `kid` to the key chain that signs for it.
 */
export interface OAuthAuthorizationServerFactory {
    forTenant(
        tenantId: string,
        sessionId?: string,
        keyChainIds?: Readonly<Record<string, string>>,
    ): Oauth2AuthorizationServer;
}

export const OAUTH_AUTHORIZATION_SERVER_FACTORY = Symbol(
    "OAUTH_AUTHORIZATION_SERVER_FACTORY",
);
