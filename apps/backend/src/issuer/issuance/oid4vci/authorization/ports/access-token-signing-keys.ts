import type { Jwk } from "@openid4vc/oauth2";

/** Keys the built-in authorization server signs access tokens with. */
export interface AccessTokenSigningKeys {
    /** Key id of the tenant's default signing key. */
    defaultKeyId(tenantId: string): Promise<string>;
    publicJwk(tenantId: string, keyId: string): Promise<Jwk>;
}

export const ACCESS_TOKEN_SIGNING_KEYS = Symbol("ACCESS_TOKEN_SIGNING_KEYS");
