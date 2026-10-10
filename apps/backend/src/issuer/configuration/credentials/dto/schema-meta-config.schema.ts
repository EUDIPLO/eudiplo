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

export const SchemaMetadataPinMode = {
    KEEP_CURRENT: "keep_current",
    UPDATE_TO_NEW_VERSION: "update_to_new_version",
    REPLACE_ID: "replace_id",
} as const;
export type SchemaMetadataPinMode =
    (typeof SchemaMetadataPinMode)[keyof typeof SchemaMetadataPinMode];

export const SchemaUriEntrySchema = z
    .object({
        credentialConfigId: z
            .string()
            .optional()
            .describe(
                "Credential configuration whose schema EUDIPLO builds and uploads; `uri` and `meta` are not needed.",
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
                "URL of a schema document that EUDIPLO downloads and uploads to the registrar. Requires `format` and `meta`.",
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
                "Trust list of the tenant. EUDIPLO publishes it as `etsi_tl` authority with its URL and the certificate of the trust list's key chain; the other fields are not needed.",
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
                "Authority value, for example the trust list URL for `etsi_tl` or the base64 DER root certificate for `x509`.",
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
            .describe(
                "Schema ID (attestation identifier URI). `publish` passes it to the registrar when set; `publish-version` requires the ID of the existing schema. With `credentialConfigId` and no `rulebookURI`, `publish` only links that credential configuration to this ID and uploads nothing.",
            ),
        name: z
            .string()
            .optional()
            .describe(
                "Human-readable name. Required when publishing; not needed for a link-only request.",
            ),
        version: z.string().describe("Schema version, for example `1.0.0`."),
        rulebookURI: z
            .string()
            .optional()
            .describe(
                "URL of the attestation rulebook, which EUDIPLO downloads and uploads to the registrar. Required when publishing.",
            ),
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
                "Trusted authorities for issuers of this attestation. Required when publishing: at least one entry must provide an X.509 certificate (`trustListId`, an `x509` entry or a `verificationMethod` with `x509Certificate`).",
            ),
    })
    .describe(
        "Schema metadata values; the registrar builds and signs the result.",
    )
    .strict();

const pinModeDescription = (target: string) =>
    `How to update the schema metadata pin of \`credentialConfigId\`: \`keep_current\` (default) keeps a pin to the same ID, \`update_to_new_version\` updates the pinned version under the same ID, \`replace_id\` repoints the pin to ${target}. A configuration without a pin is always linked. If it is pinned to another ID, only \`replace_id\` succeeds; the others answer \`400\` after the schema metadata was published.`;

export const SignSchemaMetaConfigSchema = z
    .object({
        config: SchemaMetaConfigSchema,
        credentialConfigId: z
            .string()
            .optional()
            .describe(
                "Credential configuration to link to the published schema metadata ID.",
            ),
        pinMode: z
            .enum(SchemaMetadataPinMode)
            .optional()
            .describe(pinModeDescription("the new ID")),
    })
    .describe("Request body of `POST /api/schema-metadata/publish`.")
    .strict();

export const SignVersionSchemaMetaConfigSchema = z
    .object({
        config: SchemaMetaConfigSchema,
        credentialConfigId: z
            .string()
            .optional()
            .describe("Credential configuration to link to the new version."),
        pinMode: z
            .enum(SchemaMetadataPinMode)
            .optional()
            .describe(pinModeDescription("`config.id`")),
    })
    .describe("Request body of `POST /api/schema-metadata/publish-version`.")
    .strict();
