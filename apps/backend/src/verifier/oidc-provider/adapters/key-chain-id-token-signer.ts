import type { KeyChainService } from "../../../crypto/key/key-chain.service.js";
import { ID_TOKEN_LIFETIME_SECONDS } from "../domain/oidc-sign-in.js";
import type { IdTokenSigner } from "../ports/id-token-signer.js";

/**
 * Signs ID tokens with the tenant's authorization server key chain, the one
 * that signs the access tokens of EUDIPLO's authorization servers. The
 * issuer and audience keep the two token kinds apart.
 */
export class KeyChainIdTokenSigner implements IdTokenSigner {
    constructor(
        private readonly keyChains: Pick<
            KeyChainService,
            | "resolveAuthorizationServerKeyChain"
            | "signJWT"
            | "getAccessTokenVerificationKeys"
            | "getSigningAlg"
        >,
    ) {}

    async sign(
        tenantId: string,
        claims: Record<string, unknown>,
    ): Promise<string> {
        const keyChain =
            await this.keyChains.resolveAuthorizationServerKeyChain(tenantId);
        return this.keyChains.signJWT(
            claims,
            { typ: "JWT" },
            tenantId,
            keyChain.id,
        );
    }

    async publicKeys(tenantId: string): Promise<Record<string, unknown>[]> {
        // Creates the key chain if missing, so a client that loads the JWKS
        // before the first sign-in already holds the key.
        await this.keyChains.resolveAuthorizationServerKeyChain(tenantId);
        const keys = await this.keyChains.getAccessTokenVerificationKeys(
            tenantId,
            undefined,
            ID_TOKEN_LIFETIME_SECONDS,
        );
        return keys as Record<string, unknown>[];
    }

    async algorithms(tenantId: string): Promise<string[]> {
        // The algorithm signJWT uses with this key chain.
        const keyChain =
            await this.keyChains.resolveAuthorizationServerKeyChain(tenantId);
        return [await this.keyChains.getSigningAlg(tenantId, keyChain.id)];
    }
}
