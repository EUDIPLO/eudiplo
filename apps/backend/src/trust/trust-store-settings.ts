export const TRUST_STORE_SETTINGS = Symbol("TRUST_STORE_SETTINGS");

export interface TrustStoreSettings {
    publicUrl: string;
    internalUrl?: string;
}
