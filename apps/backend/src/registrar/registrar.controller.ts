import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Patch,
    Post,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { CreateAccessCertificateDto } from "./dto/create-access-certificate.dto.js";
import { CreateRegistrarConfigDto } from "./dto/create-registrar-config.dto.js";
import { RegistrarConfigResponseDto } from "./dto/registrar-config-response.dto.js";
import { UpdateRegistrarConfigDto } from "./dto/update-registrar-config.dto.js";
import { RegistrarService } from "./registrar.service.js";

/**
 * Controller for managing registrar configuration and creating access certificates.
 * Allows tenants to configure their connection to an external registrar
 * and create access certificates for their keys.
 */
@ApiTags("Registrar")
@Secured([Role.Registrar])
@Controller("registrar")
export class RegistrarController {
    constructor(private readonly registrarService: RegistrarService) {}

    /**
     * Get the current registrar configuration for the tenant.
     * @returns The registrar configuration
     */
    @Get("config")
    @ApiOperation({ summary: "Get registrar configuration" })
    @ApiResponse({
        status: 200,
        description: "The registrar configuration",
        type: RegistrarConfigResponseDto,
    })
    @ApiResponse({
        status: 404,
        description: "No registrar configuration found",
    })
    async getConfig(
        @Token() token: TokenPayload,
    ): Promise<RegistrarConfigResponseDto> {
        const config = await this.registrarService.getConfig(token.entity!.id);
        if (!config) {
            throw new NotFoundException("No registrar configuration found");
        }
        return RegistrarConfigResponseDto.fromEntity(config);
    }

    /**
     * Create or replace the registrar configuration for the tenant.
     * Credentials are validated before saving.
     * @param token - The token payload from the auth context
     * @param dto - The configuration data
     * @returns The saved configuration
     */
    @Post("config")
    @ApiOperation({ summary: "Create or replace registrar configuration" })
    @ApiResponse({
        status: 201,
        description: "Configuration created successfully",
        type: RegistrarConfigResponseDto,
    })
    @ApiResponse({
        status: 400,
        description: "Invalid credentials",
    })
    @ApiResponse({
        status: 503,
        description:
            "Registrar OIDC endpoint unreachable — credentials could not be verified",
    })
    async createConfig(
        @Token() token: TokenPayload,
        @Body() dto: CreateRegistrarConfigDto,
    ): Promise<RegistrarConfigResponseDto> {
        const config = await this.registrarService.saveConfig(
            token.entity!.id,
            dto,
        );
        return RegistrarConfigResponseDto.fromEntity(config);
    }

    /**
     * Update the registrar configuration for the tenant.
     * Credentials are validated if auth-related fields are changed.
     * @param token - The token payload from the auth context
     * @param dto - The partial configuration data to update
     * @returns The updated configuration
     */
    @Patch("config")
    @ApiOperation({ summary: "Update registrar configuration" })
    @ApiResponse({
        status: 200,
        description: "Configuration updated successfully",
        type: RegistrarConfigResponseDto,
    })
    @ApiResponse({
        status: 400,
        description: "Invalid credentials",
    })
    @ApiResponse({
        status: 503,
        description:
            "Registrar OIDC endpoint unreachable — credentials could not be verified",
    })
    @ApiResponse({
        status: 404,
        description: "No registrar configuration found",
    })
    async updateConfig(
        @Token() token: TokenPayload,
        @Body() dto: UpdateRegistrarConfigDto,
    ): Promise<RegistrarConfigResponseDto> {
        const config = await this.registrarService.updateConfig(
            token.entity!.id,
            dto,
        );
        return RegistrarConfigResponseDto.fromEntity(config);
    }

    /**
     * Delete the registrar configuration for the tenant.
     * @param token - The token payload from the auth context
     */
    @Delete("config")
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: "Delete registrar configuration" })
    @ApiResponse({
        status: 204,
        description: "Configuration deleted successfully",
    })
    async deleteConfig(@Token() token: TokenPayload): Promise<void> {
        return this.registrarService.deleteConfig(token.entity!.id);
    }

    /**
     * Create an access certificate for a specific key.
     * The certificate will be fetched from the registrar and stored in EUDIPLO.
     * Registers the tenant as relying party at the registrar if it is not yet.
     * @param token - The token payload from the auth context
     * @param dto - The key ID to create the certificate for
     * @returns The registrar's certificate ID, the key chain ID and the PEM
     */
    @Post("access-certificate")
    @ApiOperation({
        summary: "Create an access certificate for a key",
        description:
            "Creates an access certificate at the registrar for the specified key. " +
            "Registers the tenant as relying party at the registrar if it is not yet. " +
            "The certificate is automatically stored in EUDIPLO.",
    })
    @ApiResponse({
        status: 201,
        description: "Access certificate created successfully",
        schema: {
            type: "object",
            required: ["id", "certId", "crt"],
            properties: {
                id: {
                    type: "string",
                    description: "The certificate ID at the registrar",
                },
                certId: {
                    type: "string",
                    description:
                        "ID of the key chain that now holds the certificate",
                },
                crt: {
                    type: "string",
                    description: "The certificate in PEM format",
                },
            },
        },
    })
    @ApiResponse({
        status: 400,
        description:
            "The registrar rejected the relying-party registration or the certificate request",
    })
    @ApiResponse({
        status: 404,
        description: "No registrar configuration found or key not found",
    })
    async createAccessCertificate(
        @Token() token: TokenPayload,
        @Body() dto: CreateAccessCertificateDto,
    ): Promise<{ id: string; certId: string; crt: string }> {
        return this.registrarService.createAccessCertificate(
            token.entity!.id,
            dto,
        );
    }
}
