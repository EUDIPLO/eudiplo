import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { KeyUsageType } from "../types/key-usage-type.js";

/**
 * EC JWK for export. Includes the private key for database-held keys only.
 */
class ExportEcJwk {
    @ApiProperty({ description: "Key type", example: "EC" })
    kty!: string;

    @ApiProperty({ description: "Curve", example: "P-256" })
    crv!: string;

    @ApiProperty({ description: "X coordinate (base64url)" })
    x!: string;

    @ApiProperty({ description: "Y coordinate (base64url)" })
    y!: string;

    @ApiPropertyOptional({
        description:
            "Private key (base64url). Only present for keys held in the database (`db` provider); external KMS keys are exported without private material.",
    })
    d?: string;

    @ApiPropertyOptional({ description: "Algorithm", example: "ES256" })
    alg?: string;

    @ApiPropertyOptional({ description: "Key ID" })
    kid?: string;
}

/**
 * Rotation policy for exported key chains.
 */
class ExportRotationPolicyDto {
    @ApiProperty({ description: "Whether rotation is enabled." })
    enabled!: boolean;

    @ApiPropertyOptional({ description: "Rotation interval in days." })
    intervalDays?: number;

    @ApiPropertyOptional({ description: "Certificate validity in days." })
    certValidityDays?: number;
}

/**
 * DTO for exporting a key chain in config-import-compatible format.
 *
 * This matches the shape of key chain JSON files in the config folder,
 * so it can be saved and later imported via the config import mechanism.
 */
export class KeyChainExportDto {
    @ApiProperty({ description: "Key chain ID." })
    id!: string;

    @ApiPropertyOptional({ description: "Human-readable description." })
    description?: string;

    @ApiProperty({
        description: "Usage type for this key chain.",
        enum: KeyUsageType,
    })
    usageType!: KeyUsageType;

    @ApiProperty({
        description:
            "The key in JWK format (EC). Contains the private key for database-held keys and only the public key for external KMS providers.",
    })
    key!: ExportEcJwk;

    @ApiPropertyOptional({
        description:
            "Certificate chain in PEM format (leaf first, then intermediates/CA).",
    })
    crt?: string[];

    @ApiPropertyOptional({ description: "KMS provider name." })
    kmsProvider?: string;

    @ApiPropertyOptional({ description: "Rotation policy." })
    rotationPolicy?: ExportRotationPolicyDto;
}
