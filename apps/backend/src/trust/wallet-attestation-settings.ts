export const WALLET_ATTESTATION_SETTINGS = Symbol(
    "WALLET_ATTESTATION_SETTINGS",
);

export interface WalletAttestationSettings {
    cryptoToleranceSeconds: number;
}
