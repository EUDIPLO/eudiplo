import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SchemaURIMeta } from "@owf/eudi-attestation-schema";
import { createZodDto } from "nestjs-zod";
import {
    AttestationLoS,
    SchemaMetaBindingType,
    SchemaMetaConfigSchema,
    SchemaMetadataPinMode,
    SchemaMetaFrameworkType,
    SchemaUriEntrySchema,
    SignSchemaMetaConfigSchema,
    SignVersionSchemaMetaConfigSchema,
    TrustAuthorityEntrySchema,
} from "./schema-meta-config.schema.js";

export {
    AttestationLoS,
    SchemaMetaBindingType,
    SchemaMetadataPinMode,
    SchemaMetaFrameworkType,
} from "./schema-meta-config.schema.js";

// Field descriptions come from the Zod schemas (also rendered in the docs);
// the decorators only add what Swagger cannot derive from them.

/**
 * Schema URI entry per attestation format.
 */
export class SchemaUriEntry extends createZodDto(SchemaUriEntrySchema) {
    @ApiPropertyOptional({ example: "pid_de_credential_config" })
    credentialConfigId?: string;

    @ApiPropertyOptional({ example: "dc+sd-jwt" })
    format?: string;

    @ApiPropertyOptional()
    uri?: string;

    @ApiProperty({ type: "object", additionalProperties: true })
    meta?: SchemaURIMeta;
}

/**
 * Trust authority entry for TS11 SchemaMeta.
 */
export class TrustAuthorityEntry extends createZodDto(
    TrustAuthorityEntrySchema,
) {
    @ApiPropertyOptional()
    trustListId?: string;

    @ApiPropertyOptional({ enum: SchemaMetaFrameworkType })
    frameworkType?: SchemaMetaFrameworkType;

    @ApiPropertyOptional()
    value?: string;

    @ApiPropertyOptional({
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
 * @see https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/ts11-interfaces-and-formats-for-catalogue-of-attributes-and-catalogue-of-schemes.md
 *
 * @experimental The underlying TS11 specification is not yet finalized.
 */
export class SchemaMetaConfig extends createZodDto(SchemaMetaConfigSchema) {
    @ApiPropertyOptional({
        example: "https://example.com/attestations/my-credential",
    })
    id?: string;

    @ApiPropertyOptional({ example: "German PID" })
    name?: string;

    @ApiProperty({ example: "1.0.0" })
    version!: string;

    @ApiPropertyOptional({
        example: "https://example.com/rulebooks/my-credential/1.0.0.md",
    })
    rulebookURI?: string;

    @ApiProperty({ enum: AttestationLoS })
    attestationLoS!: AttestationLoS;

    @ApiProperty({ enum: SchemaMetaBindingType })
    bindingType!: SchemaMetaBindingType;

    @ApiPropertyOptional({ type: () => [SchemaUriEntry] })
    schemaURIs?: SchemaUriEntry[];

    @ApiPropertyOptional({ type: () => [TrustAuthorityEntry] })
    trustedAuthorities?: TrustAuthorityEntry[];
}

/**
 * Request body for schema metadata submission.
 *
 * The registrar builds and signs schema metadata from the submitted values.
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

    @ApiPropertyOptional()
    credentialConfigId?: string;

    @ApiPropertyOptional({
        enum: SchemaMetadataPinMode,
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

    @ApiPropertyOptional()
    credentialConfigId?: string;

    @ApiPropertyOptional({
        enum: SchemaMetadataPinMode,
        default: SchemaMetadataPinMode.KEEP_CURRENT,
    })
    pinMode?: SchemaMetadataPinMode;
}
