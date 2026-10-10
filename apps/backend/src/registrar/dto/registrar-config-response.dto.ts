import { ApiProperty, OmitType } from "@nestjs/swagger";
import { RegistrarConfigEntity } from "../entities/registrar-config.entity.js";

/**
 * DTO for the registrar configuration response.
 * Excludes the password and client secret for security and includes flags
 * indicating whether they are set.
 */
export class RegistrarConfigResponseDto extends OmitType(
    RegistrarConfigEntity,
    ["tenant", "tenantId", "password", "clientSecret"] as const,
) {
    /**
     * Indicates whether a password is configured.
     * The actual password is never returned for security reasons.
     */
    @ApiProperty({
        description:
            "Indicates whether a password is configured (actual password is never returned)",
        example: true,
    })
    hasPassword!: boolean;

    /**
     * Indicates whether a client secret is configured.
     * The actual client secret is never returned for security reasons.
     */
    @ApiProperty({
        description:
            "Indicates whether a client secret is configured (actual client secret is never returned)",
        example: false,
    })
    hasClientSecret!: boolean;

    /**
     * Create a response DTO from an entity.
     * @param entity - The registrar config entity
     * @returns The response DTO without password and client secret
     */
    static fromEntity(
        entity: RegistrarConfigEntity,
    ): RegistrarConfigResponseDto {
        const dto = new RegistrarConfigResponseDto();
        dto.registrarUrl = entity.registrarUrl;
        dto.oidcUrl = entity.oidcUrl;
        dto.clientId = entity.clientId;
        dto.username = entity.username;
        dto.registrationCertificateDefaults =
            entity.registrationCertificateDefaults;
        dto.hasPassword = !!entity.password;
        dto.hasClientSecret = !!entity.clientSecret;
        return dto;
    }
}
