import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SchemaURIMeta } from "@owf/eudi-attestation-schema";
import { createZodDto } from "nestjs-zod";
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

const SchemaUriEntrySchema = z
    .object({
        credentialConfigId: z.string().optional(),
        format: z.string().optional(),
        uri: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();

const TrustAuthorityEntrySchema = z
    .object({
        trustListId: z.string().optional(),
        frameworkType: z.enum(SchemaMetaFrameworkType).optional(),
        value: z.string().optional(),
        verificationMethod: z
            .union([z.record(z.string(), z.unknown()), z.string()])
            .optional(),
    })
    .strict();

const SchemaMetaConfigSchema = z
    .object({
        id: z.string().optional(),
        name: z.string().optional(),
        version: z.string(),
        rulebookURI: z.string().optional(),
        attestationLoS: z.enum(AttestationLoS),
        bindingType: z.enum(SchemaMetaBindingType),
        schemaURIs: z.array(SchemaUriEntrySchema).optional(),
        trustedAuthorities: z.array(TrustAuthorityEntrySchema).optional(),
    })
    .strict();

const SignSchemaMetaConfigSchema = z
    .object({
        config: SchemaMetaConfigSchema,
        credentialConfigId: z.string().optional(),
        pinMode: z.enum(SchemaMetadataPinMode).optional(),
    })
    .strict();

const SignVersionSchemaMetaConfigSchema = z
    .object({
        config: SchemaMetaConfigSchema,
        credentialConfigId: z.string().optional(),
        pinMode: z.enum(SchemaMetadataPinMode).optional(),
    })
    .strict();

/**
 * Schema URI entry per attestation format.
 */
export class SchemaUriEntry extends createZodDto(SchemaUriEntrySchema) {
    @ApiPropertyOptional({
        description:
            "Credential config ID to resolve and upload its schema content. " +
            "When set, uri can be omitted and is resolved server-side.",
        example: "pid_de_credential_config",
    })
    credentialConfigId?: string;

    @ApiPropertyOptional({
        description:
            "Attestation format this schema URI applies to (e.g. dc+sd-jwt, mso_mdoc)",
        example: "dc+sd-jwt",
    })
    format?: string;

    @ApiPropertyOptional({
        description: "URI pointing to the schema document for this format",
    })
    uri?: string;

    @ApiProperty({
        description:
            "Schema-format specific metadata (for example { vct: 'urn:example:vct' } for dc+sd-jwt).",
        type: "object",
        additionalProperties: true,
    })
    meta?: SchemaURIMeta;
}

/**
 * Trust authority entry for TS11 SchemaMeta.
 */
export class TrustAuthorityEntry extends createZodDto(
    TrustAuthorityEntrySchema,
) {
    @ApiPropertyOptional({
        description:
            "Trust list ID to resolve from the database. " +
            "When set, frameworkType, value, and verificationMethod are derived automatically.",
    })
    trustListId?: string;

    @ApiPropertyOptional({
        enum: SchemaMetaFrameworkType,
        description: "Trust framework type (ignored when trustListId is set)",
    })
    frameworkType?: SchemaMetaFrameworkType;

    @ApiPropertyOptional({
        description:
            "Trust list URI for etsi_tl or base64-encoded DER root certificate for x509 (ignored when trustListId is set)",
    })
    value?: string;

    @ApiPropertyOptional({
        description:
            "Optional verification material for external trusted authorities (for example a JWK). " +
            "Required for etsi_tl and omitted for x509 root certificate anchors. " +
            "For internal trust-list URLs, EUDIPLO resolves verification material from the database.",
        oneOf: [
            {
                type: "object",
                additionalProperties: true,
            },
            {
                type: "string",
                description:
                    "JSON string representing an object. Parsed server-side for form submissions.",
            },
        ],
    })
    verificationMethod?: Record<string, unknown> | string;
}

/**
 * TS11-specific configuration for schema metadata generation.
 *
 * When present on a CredentialConfig, EUDIPLO can generate a SchemaMeta
 * object per the EUDI Catalogue of Attestations specification (TS11).
 *
 * @see https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/ts11-interfaces-and-formats-for-catalogue-of-attributes-and-catalogue-of-schemes.md
 *
 * @experimental The underlying TS11 specification is not yet finalized.
 */
export class SchemaMetaConfig extends createZodDto(SchemaMetaConfigSchema) {
    @ApiPropertyOptional({
        description:
            "Optional override for the schema ID (attestation identifier URI). " +
            "When not set, derived from vct (dc+sd-jwt) or docType (mso_mdoc).",
        example: "https://example.com/attestations/my-credential",
    })
    id?: string;

    @ApiPropertyOptional({
        description:
            "Human-readable name of the schema metadata entry. Required when publishing new schema metadata; optional when linking an existing schema metadata id to a credential config.",
        example: "German PID",
    })
    name?: string;

    @ApiPropertyOptional({
        description: "Schema version in SemVer format",
        example: "1.0.0",
    })
    version!: string;

    @ApiPropertyOptional({
        description:
            "URI of the Attestation Rulebook. Required when publishing new schema metadata; optional when linking an existing schema metadata id to a credential config.",
        example: "https://example.com/rulebooks/my-credential/1.0.0.md",
    })
    rulebookURI?: string;

    @ApiPropertyOptional({
        enum: AttestationLoS,
        description: "Attestation Level of Security",
    })
    attestationLoS!: AttestationLoS;

    @ApiPropertyOptional({
        enum: SchemaMetaBindingType,
        description: "Cryptographic binding type",
    })
    bindingType!: SchemaMetaBindingType;

    @ApiPropertyOptional({
        type: () => [SchemaUriEntry],
        description:
            "Schema URIs per attestation format. " +
            "When omitted, the format is derived from the credential config format field.",
    })
    schemaURIs?: SchemaUriEntry[];

    @ApiPropertyOptional({
        type: () => [TrustAuthorityEntry],
        description: "Trust authorities for this attestation schema",
    })
    trustedAuthorities?: TrustAuthorityEntry[];
}

/**
 * Request body for schema metadata submission.
 *
 * The registrar builds and signs schema metadata from the submitted values.
 * EUDIPLO no longer performs local SchemaMetadata JWT signing for this flow.
 */
export class SignSchemaMetaConfigDto extends createZodDto(
    SignSchemaMetaConfigSchema,
) {
    @ApiProperty({
        type: () => SchemaMetaConfig,
        description:
            "The schema metadata configuration to submit. Registrar builds and signs the final schema metadata.",
    })
    config!: SchemaMetaConfig;

    @ApiPropertyOptional({
        description:
            "ID of the credential config to link back after submission. " +
            "When provided, schemaMeta.id on the credential config is updated with the reserved attestation ID.",
    })
    credentialConfigId?: string;

    @ApiPropertyOptional({
        enum: SchemaMetadataPinMode,
        description:
            "How to update credential config pinning after publish. keep_current: do not change existing pin (unless empty). update_to_new_version: update pinned version under current id. replace_id: repoint pin to a different schema id.",
        default: SchemaMetadataPinMode.KEEP_CURRENT,
    })
    pinMode?: SchemaMetadataPinMode;
}

/**
 * Request body for new schema metadata version submission.
 *
 * The registrar builds and signs the new version.
 */
export class SignVersionSchemaMetaConfigDto extends createZodDto(
    SignVersionSchemaMetaConfigSchema,
) {
    @ApiProperty({
        type: () => SchemaMetaConfig,
        description:
            "The schema metadata configuration to submit as a new version. Must include the existing id.",
    })
    config!: SchemaMetaConfig;

    @ApiPropertyOptional({
        description:
            "Optional credential config to update pinning for after successful version publish.",
    })
    credentialConfigId?: string;

    @ApiPropertyOptional({
        enum: SchemaMetadataPinMode,
        description:
            "How to update credential config pinning after version publish. keep_current: do not change existing pin (unless empty). update_to_new_version: update pinned version under current id. replace_id: repoint pin to config.id.",
        default: SchemaMetadataPinMode.KEEP_CURRENT,
    })
    pinMode?: SchemaMetadataPinMode;
}
