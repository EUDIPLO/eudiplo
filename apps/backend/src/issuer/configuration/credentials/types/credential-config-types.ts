/**
 * Utility types and helpers for working with credential configurations.
 * Re-exports and extends types from @openid4vc/openid4vci for type-safe
 * credential configuration building.
 */

import type {
    CredentialConfigurationSupported,
    CredentialConfigurationSupportedWithFormats,
    MsoMdocFormatIdentifier,
} from "@openid4vc/openid4vci";

/**
 * Format identifier constants for runtime checks
 */
export const MSO_MDOC_FORMAT: MsoMdocFormatIdentifier = "mso_mdoc";
const SD_JWT_DC_FORMAT = "dc+sd-jwt" as const;

type SdJwtDcFormatIdentifier = typeof SD_JWT_DC_FORMAT;

/**
 * Extract mso_mdoc specific configuration from the SDK union type
 */
export type MsoMdocCredentialConfig = Extract<
    CredentialConfigurationSupportedWithFormats,
    { format: MsoMdocFormatIdentifier }
>;

/**
 * Extract dc+sd-jwt specific configuration from the SDK union type
 */
export type SdJwtDcCredentialConfig = Extract<
    CredentialConfigurationSupportedWithFormats,
    { format: SdJwtDcFormatIdentifier }
>;

/**
 * Union of the credential configs we actively support
 */
export type TypedCredentialConfig =
    | SdJwtDcCredentialConfig
    | MsoMdocCredentialConfig;

/**
 * Type guard to check if a config is for mso_mdoc format
 */
function _isMsoMdocConfig(
    config:
        | CredentialConfigurationSupported
        | CredentialConfigurationSupportedWithFormats,
): config is MsoMdocCredentialConfig {
    return config.format === MSO_MDOC_FORMAT;
}

/**
 * Type guard to check if a config is for dc+sd-jwt format
 */
function _isSdJwtDcConfig(
    config:
        | CredentialConfigurationSupported
        | CredentialConfigurationSupportedWithFormats,
): config is SdJwtDcCredentialConfig {
    return config.format === SD_JWT_DC_FORMAT;
}

/**
 * Options for building credential configuration
 */
export interface BuildCredentialConfigOptions {
    /** Supported signing algorithms for the format */
    signingAlgorithms: string[] | number[];
    /**
     * Key binding of the credential: its binding methods (e.g., "jwk",
     * "cose_key") and the proof types it accepts. Without it, both are left
     * out of the metadata and wallets send no proofs (OpenID4VCI 1.0
     * Section 12.2.4).
     */
    keyBinding?: {
        bindingMethods: string[];
        proofTypesSupported: ProofTypesSupported;
    };
}

/** `proof_types_supported` of a credential configuration. */
export type ProofTypesSupported = NonNullable<
    MsoMdocCredentialConfig["proof_types_supported"]
>;

/**
 * Claim path element - string (object key), number (array index), or null (any element)
 */
type ClaimPathElement = string | number | null;

/**
 * Claim display information in a specific locale for credential_metadata
 */
interface ClaimDisplayInput {
    name?: string;
    locale?: string;
}

/**
 * Single claim metadata entry for credential_metadata.claims
 */
interface ClaimMetadataInput {
    path: ClaimPathElement[];
    mandatory?: boolean;
    display?: ClaimDisplayInput[];
}

/**
 * Credential metadata input - accepts display array and claims array
 * Using a more permissive type to allow entity Display[] to be passed
 */
export interface CredentialMetadataInput {
    display?: Array<{
        name: string;
        locale?: string;
        logo?: { uri?: string; alt_text?: string };
        description?: string;
        background_color?: string;
        background_image?: { uri?: string };
        text_color?: string;
    }>;
    claims?: ClaimMetadataInput[];
}

/**
 * `cryptographic_binding_methods_supported` and `proof_types_supported`:
 * both present or both absent (OpenID4VCI 1.0 Section 12.2.4).
 */
function keyBindingMetadata(options: BuildCredentialConfigOptions) {
    if (!options.keyBinding) return {};
    return {
        cryptographic_binding_methods_supported:
            options.keyBinding.bindingMethods,
        proof_types_supported: options.keyBinding.proofTypesSupported,
    };
}

/**
 * Build an mso_mdoc credential configuration
 */
export function buildMsoMdocConfig(
    doctype: string,
    options: BuildCredentialConfigOptions,
    metadata?: CredentialMetadataInput,
    scope?: string,
): MsoMdocCredentialConfig {
    return {
        format: MSO_MDOC_FORMAT,
        doctype,
        credential_signing_alg_values_supported:
            options.signingAlgorithms as number[],
        ...keyBindingMetadata(options),
        ...(metadata && { credential_metadata: metadata }),
        ...(scope && { scope }),
    } as MsoMdocCredentialConfig;
}

/**
 * Build a dc+sd-jwt credential configuration
 */
export function buildSdJwtDcConfig(
    vct: string,
    options: BuildCredentialConfigOptions,
    metadata?: CredentialMetadataInput,
    scope?: string,
): SdJwtDcCredentialConfig {
    return {
        format: SD_JWT_DC_FORMAT,
        vct,
        credential_signing_alg_values_supported:
            options.signingAlgorithms as string[],
        ...keyBindingMetadata(options),
        ...(metadata && { credential_metadata: metadata }),
        ...(scope && { scope }),
    } as SdJwtDcCredentialConfig;
}

/**
 * Converts a TypedCredentialConfig to CredentialConfigurationSupported
 * This is a type assertion helper since our types are derived from the SDK
 */
export function toCredentialConfigurationSupported(
    config: TypedCredentialConfig,
): CredentialConfigurationSupportedWithFormats {
    return config;
}
