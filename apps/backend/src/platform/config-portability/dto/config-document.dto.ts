import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

class ConfigDocumentMetadataDto {
    @ApiPropertyOptional({
        description: "Generation of the stored definition",
        minimum: 1,
    })
    generation?: number;

    @ApiPropertyOptional({
        enum: ["unmanaged", "file-managed"],
        description: "Who owns the resource",
    })
    ownership?: "unmanaged" | "file-managed";
}

/** One configuration document, as in the config folder and in bundles. */
export class ConfigDocumentDto {
    @ApiProperty({
        description:
            "Canonical schema URL; names the kind and the format version",
        example:
            "https://eudiplo.dev/schemas/v3/CredentialConfigFile.schema.json",
    })
    $schema!: string;

    @ApiPropertyOptional({ type: ConfigDocumentMetadataDto })
    metadata?: ConfigDocumentMetadataDto;

    @ApiProperty({
        type: "object",
        additionalProperties: true,
        description: "The resource configuration in the schema's format",
    })
    spec!: Record<string, unknown>;
}
