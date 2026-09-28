import type { CredentialConfigurationSupported } from "@openid4vc/openid4vci";

/** Tenant data advertised in the credential issuer metadata. */
export interface IssuerMetadataSources {
    credentialConfigurationsSupported(
        tenantId: string,
    ): Promise<Record<string, CredentialConfigurationSupported>>;
    /** Public JWK wallets use to encrypt credential requests. */
    credentialRequestEncryptionKey(tenantId: string): Promise<object>;
}

export const ISSUER_METADATA_SOURCES = Symbol("ISSUER_METADATA_SOURCES");
