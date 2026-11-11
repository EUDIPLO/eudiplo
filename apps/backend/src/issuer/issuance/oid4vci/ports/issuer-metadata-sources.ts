import type { CredentialConfigurationSupported } from "@openid4vc/openid4vci";

/**
 * Public JWK in `credential_request_encryption.jwks`. The wallet names it by
 * `kid` in the JWE header and uses its `alg`.
 */
export type CredentialRequestEncryptionKey = {
    kty: string;
    kid: string;
    alg: string;
    [parameter: string]: unknown;
};

/** Tenant data advertised in the credential issuer metadata. */
export interface IssuerMetadataSources {
    credentialConfigurationsSupported(
        tenantId: string,
    ): Promise<Record<string, CredentialConfigurationSupported>>;
    /** Public JWK wallets use to encrypt credential requests. */
    credentialRequestEncryptionKey(
        tenantId: string,
    ): Promise<CredentialRequestEncryptionKey>;
}

export const ISSUER_METADATA_SOURCES = Symbol("ISSUER_METADATA_SOURCES");
