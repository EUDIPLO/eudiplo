import type { TrustListRef } from "../../../../../trust/types.js";

export interface WalletAttestationPolicyConfig {
    walletAttestationRequired?: boolean | null;
    walletProviderTrustLists?: TrustListRef[] | null;
}

export interface ResolvedWalletAttestationPolicy {
    walletAttestationRequired: boolean;
    walletProviderTrustLists: TrustListRef[];
}

export function resolveWalletAttestationPolicy(
    issuanceConfig: WalletAttestationPolicyConfig,
    authorizationServerConfig?: WalletAttestationPolicyConfig,
): ResolvedWalletAttestationPolicy {
    return {
        walletAttestationRequired:
            authorizationServerConfig?.walletAttestationRequired ??
            issuanceConfig.walletAttestationRequired ??
            false,
        walletProviderTrustLists:
            authorizationServerConfig?.walletProviderTrustLists ??
            issuanceConfig.walletProviderTrustLists ??
            [],
    };
}
