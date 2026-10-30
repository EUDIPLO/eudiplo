import type { Jwk } from "@openid4vc/oauth2";

/** The key chain that signs an access token and its active public key. */
interface AccessTokenSigningKey {
    keyId: string;
    publicJwk: Jwk;
}

/** Keys the built-in authorization server signs access tokens with. */
export interface AccessTokenSigningKeys {
    /**
     * The key chain `keyId` names, else the tenant's access token key chain.
     * Only key chains of usage type `accessToken` qualify.
     */
    resolve(tenantId: string, keyId?: string): Promise<AccessTokenSigningKey>;
}

export const ACCESS_TOKEN_SIGNING_KEYS = Symbol("ACCESS_TOKEN_SIGNING_KEYS");
