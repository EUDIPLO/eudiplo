import type { JWK } from "jose";
import { KeyUsageType } from "../types/key-usage-type.js";
import { toPublicJwk } from "./public-jwk.js";

/**
 * ID of the access token key chain EUDIPLO creates for a tenant that has
 * none. A fixed ID makes the creation idempotent when several requests or
 * instances need it at once.
 */
export const DEFAULT_ACCESS_TOKEN_KEY_CHAIN_ID = "access-token";

/**
 * Why the key chain cannot sign an authorization server's access tokens, or
 * undefined when its usage type is `accessToken`.
 */
export function accessTokenKeyChainUsageRefusal(
    keyChainId: string,
    usageType: unknown,
): string | undefined {
    return usageType === KeyUsageType.AccessToken
        ? undefined
        : `Key chain ${JSON.stringify(keyChainId)} has usage type ${JSON.stringify(usageType)}; token.signingKeyId needs a key chain with usage type "accessToken".`;
}

/** What {@link accessTokenVerificationKeys} reads from a key chain. */
export interface AccessTokenKeyChainKeys {
    id: string;
    activeJwk: JWK;
    previousJwk?: JWK | null;
    lastRotatedAt?: Date | null;
}

/**
 * Public keys that verify the access tokens of an authorization server: the
 * active key, and the key it replaced while a token signed just before the
 * rotation can still be valid, that is for `lifetimeSeconds` after it. A key
 * without `kid` gets the key chain ID, which the token header then carries
 * too.
 */
export function accessTokenVerificationKeys(
    keyChain: AccessTokenKeyChainKeys,
    lifetimeSeconds: number,
    now: Date = new Date(),
): JWK[] {
    const keys = [keyChain.activeJwk];
    if (
        keyChain.previousJwk &&
        keyChain.lastRotatedAt &&
        keyChain.lastRotatedAt.getTime() + lifetimeSeconds * 1000 >
            now.getTime()
    ) {
        keys.push(keyChain.previousJwk);
    }
    return keys.map((key) => ({
        ...toPublicJwk(key),
        kid: key.kid ?? keyChain.id,
    }));
}
