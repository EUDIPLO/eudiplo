import { type Jwk, Oauth2AuthorizationServer } from "@openid4vc/oauth2";
import type { CryptoService } from "../../../../../crypto/crypto.service.js";
import type { KeyChainService } from "../../../../../crypto/key/key-chain.service.js";
import type { SessionConfigService } from "../../../../../session/session-config.service.js";
import type { TrustListRef } from "../../../../../trust/types.js";
import type { WalletAttestationService } from "../../../../../trust/wallet-attestation.service.js";
import type { IssuanceService } from "../../../../configuration/issuance/issuance.service.js";
import type { StatusListConfigService } from "../../../../status-list/status-list-config.service.js";
import type { AccessTokenSigningKeys } from "../ports/access-token-signing-keys.js";
import type { BuiltInAuthorizationServerConfiguration } from "../ports/built-in-authorization-server-configuration.js";
import type {
    ClientAttestation,
    ClientAttestationVerifier,
} from "../ports/client-attestation-verifier.js";
import type { OAuthAuthorizationServerFactory } from "../ports/oauth-authorization-server-factory.js";

/** OAuth library authorization server backed by the tenant's crypto callbacks. */
export class CryptoOAuthAuthorizationServerFactory
    implements OAuthAuthorizationServerFactory
{
    constructor(private readonly crypto: CryptoService) {}

    forTenant(tenantId: string, sessionId?: string) {
        return new Oauth2AuthorizationServer({
            callbacks: this.crypto.getCallbackContext(tenantId, sessionId),
        });
    }
}

/** Reads issuance and status list configuration for the built-in authorization server. */
export class ConfiguredBuiltInAuthorizationServerConfiguration
    implements BuiltInAuthorizationServerConfiguration
{
    constructor(
        private readonly issuance: IssuanceService,
        private readonly statusLists: StatusListConfigService,
        private readonly sessionConfig: Pick<
            SessionConfigService,
            "getEffectiveTtlSeconds"
        >,
    ) {}

    issuanceConfiguration(tenantId: string) {
        return this.issuance.getIssuanceConfiguration(tenantId);
    }

    async statusListAggregationEnabled(tenantId: string) {
        const config = await this.statusLists.getEffectiveConfig(tenantId);
        return !!config.enableAggregation;
    }

    sessionTtlSeconds(tenantId: string) {
        return this.sessionConfig.getEffectiveTtlSeconds(tenantId);
    }
}

/** Wallet attestation verification of the trust capability. */
export class WalletAttestationClientVerifier
    implements ClientAttestationVerifier
{
    constructor(private readonly walletAttestation: WalletAttestationService) {}

    verify(
        tenantId: string,
        attestation: ClientAttestation | undefined,
        expectedAudience: string,
        required: boolean,
        trustLists: TrustListRef[],
    ) {
        return this.walletAttestation.verifyWalletAttestation(
            tenantId,
            attestation,
            expectedAudience,
            required,
            trustLists,
        );
    }
}

/** Access token signing keys from the tenant key chain. */
export class KeyChainAccessTokenSigningKeys implements AccessTokenSigningKeys {
    constructor(private readonly keyChain: KeyChainService) {}

    defaultKeyId(tenantId: string) {
        return this.keyChain.getKid(tenantId);
    }

    async publicJwk(tenantId: string, keyId: string) {
        return (await this.keyChain.getPublicKey(
            "jwk",
            tenantId,
            keyId,
        )) as Jwk;
    }
}
