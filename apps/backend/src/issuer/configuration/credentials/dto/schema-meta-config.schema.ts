import { z } from "zod";

/**
 * Attestation Level of Security (LoS) as defined in TS11.
 */
export const AttestationLoS = {
    HIGH: "iso_18045_high",
    MODERATE: "iso_18045_moderate",
    ENHANCED_BASIC: "iso_18045_enhanced-basic",
    BASIC: "iso_18045_basic",
} as const;
export type AttestationLoS =
    (typeof AttestationLoS)[keyof typeof AttestationLoS];

/**
 * Cryptographic binding type as defined in TS11.
 */
export const SchemaMetaBindingType = {
    CLAIM: "claim",
    KEY: "key",
    BIOMETRIC: "biometric",
    NONE: "none",
} as const;
export type SchemaMetaBindingType =
    (typeof SchemaMetaBindingType)[keyof typeof SchemaMetaBindingType];

/**
 * Trust framework type for trusted authorities.
 */
export const SchemaMetaFrameworkType = {
    AKI: "aki",
    ETSI_TL: "etsi_tl",
    OPENID_FEDERATION: "openid_federation",
    X509: "x509",
} as const;
export type SchemaMetaFrameworkType =
    (typeof SchemaMetaFrameworkType)[keyof typeof SchemaMetaFrameworkType];

export const SchemaUriEntrySchema = z
    .object({
        credentialConfigId: z
            .string()
            .optional()
            .describe(
                "Credential configuration whose schema EUDIPLO builds; `uri` and `meta` are not needed.",
            ),
        format: z
            .string()
            .optional()
            .describe(
                "Attestation format of the schema, for example `dc+sd-jwt` or `mso_mdoc`. Required with `uri`; with `credentialConfigId`, the format of the configuration takes precedence.",
            ),
        uri: z
            .string()
            .optional()
            .describe(
                "URL of a schema document. Requires `format` and `meta`.",
            ),
        meta: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
                'Format-specific schema metadata, for example `{ "vct": "urn:example:vct" }` for `dc+sd-jwt`. Required with `uri`.',
            ),
    })
    .describe(
        "Schema of one attestation format: built from a credential configuration or downloaded from `uri`.",
    )
    .strict();

export const TrustAuthorityEntrySchema = z
    .object({
        trustListId: z
            .string()
            .optional()
            .describe(
                "Trust list of the tenant, standing for an `etsi_tl` authority with its URL and the active certificate of its key chain (the first one of a chain); the other fields are not needed.",
            ),
        frameworkType: z
            .enum(SchemaMetaFrameworkType)
            .optional()
            .describe(
                "Trust framework of an external authority. `x509` takes a root certificate in `value` and no `verificationMethod`.",
            ),
        value: z
            .string()
            .optional()
            .describe(
                "Authority value, for example the trust list URL for `etsi_tl`, or for `x509` one root certificate in PEM or base64 DER. Publishing rejects an `x509` value that holds more than one certificate, such as a chain.",
            ),
        verificationMethod: z
            .union([z.record(z.string(), z.unknown()), z.string()])
            .optional()
            .describe(
                "Verification material of an external authority, for example a JWK, as object or JSON string. Required, except for `x509` (must be omitted) and for a `value` that is a trust list URL of this tenant (EUDIPLO adds the certificate).",
            ),
    })
    .describe(
        "Trusted authority: a trust list of the tenant (`trustListId`) or an external authority.",
    )
    .strict();

export const SchemaMetaConfigSchema = z
    .object({
        id: z
            .string()
            .optional()
            .describe("Schema ID (attestation identifier URI)."),
        name: z.string().optional().describe("Human-readable name."),
        version: z.string().describe("Schema version, for example `1.0.0`."),
        rulebookURI: z
            .string()
            .optional()
            .describe("URL of the attestation rulebook."),
        attestationLoS: z
            .enum(AttestationLoS)
            .describe("Attestation level of security."),
        bindingType: z
            .enum(SchemaMetaBindingType)
            .describe("Cryptographic binding type."),
        schemaURIs: z
            .array(SchemaUriEntrySchema)
            .optional()
            .describe(
                "Schemas per attestation format. When omitted, the schema of `credentialConfigId` is used.",
            ),
        trustedAuthorities: z
            .array(TrustAuthorityEntrySchema)
            .optional()
            .describe(
                "Trusted authorities for issuers of this attestation (`trustListId`, an `x509` entry or a `verificationMethod`).",
            ),
    })
    .describe(
        "TS11 schema metadata values of the credential type. EUDIPLO stores them; no registrar adapter publishes them yet.",
    )
    .strict();
