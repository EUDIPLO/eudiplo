import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import {
    KeyChainUpdateSchema,
    RotationPolicyUpdateSchema,
} from "../schemas/key-chain.schema.js";

/**
 * DTO for updating rotation policy.
 */
export class RotationPolicyUpdateDto extends createZodDto(
    RotationPolicyUpdateSchema,
) {
    @ApiPropertyOptional({
        description:
            "Whether automatic key rotation is enabled. Enabling it needs intervalDays, in the request or already set on the key chain.",
    })
    enabled?: boolean;

    @ApiPropertyOptional({
        description: "Rotation interval in days.",
        minimum: 1,
        maximum: 3650,
    })
    intervalDays?: number;

    @ApiPropertyOptional({
        description: "Certificate validity in days.",
        minimum: 1,
        maximum: 3650,
    })
    certValidityDays?: number;
}

/**
 * DTO for updating a key chain.
 *
 * Only metadata and rotation policy can be updated.
 * Key material and certificates are managed internally.
 */
export class KeyChainUpdateDto extends createZodDto(KeyChainUpdateSchema) {
    @ApiPropertyOptional({
        description: "Human-readable description for the key chain.",
    })
    description?: string;

    @ApiPropertyOptional({
        description: "Rotation policy configuration.",
        type: RotationPolicyUpdateDto,
    })
    rotationPolicy?: RotationPolicyUpdateDto;

    @ApiPropertyOptional({
        description:
            "Active certificate chain in PEM format, leaf first, for example the certificate an external CA issued for a CSR from `GET /api/key-chain/{id}/csr`. The leaf must hold the public key of the active key, and each further certificate must have issued the one before it.",
    })
    activeCertificate?: string;
}
