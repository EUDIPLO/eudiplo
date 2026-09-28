export const OID4VP_SETTINGS = Symbol("OID4VP_SETTINGS");

export interface Oid4vpSettings {
    publicUrl: string;
    removeTrustedAuthorities: boolean;
    logDecryptedResponse: boolean;
}
