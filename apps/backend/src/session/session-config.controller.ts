import { Body, Controller, Delete, Get, HttpCode, Put } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { SessionStorageConfig } from "../auth/tenant/entities/session-storage-config.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { UpdateSessionConfigDto } from "./dto/update-session-config.dto.js";
import { SessionConfigService } from "./session-config.service.js";

/**
 * Controller for managing session storage configuration.
 * Accessible by tenant members with appropriate permissions.
 */
@ApiTags("Session")
@Secured([Role.Issuances, Role.Presentations])
@Controller("session-config")
export class SessionConfigController {
    constructor(private readonly sessionConfigService: SessionConfigService) {}

    /**
     * Get the current session storage configuration for the authenticated tenant.
     */
    @Secured([Role.IssuanceRead, Role.PresentationRead])
    @Get()
    @ApiOperation({
        summary: "Get session storage configuration",
        description:
            "Returns the session storage configuration for the current tenant.",
    })
    @ApiResponse({
        status: 200,
        description: "The session storage configuration",
        type: SessionStorageConfig,
    })
    getConfig(
        @Token() token: TokenPayload,
    ): Promise<SessionStorageConfig | null> {
        return this.sessionConfigService.getConfig(token.entity!.id);
    }

    /**
     * Update the session storage configuration for the authenticated tenant.
     */
    @Put()
    @ApiOperation({
        summary: "Update session storage configuration",
        description:
            "Updates the session storage configuration for the current tenant.",
    })
    @ApiResponse({
        status: 200,
        description: "The updated session storage configuration",
        type: SessionStorageConfig,
    })
    updateConfig(
        @Token() token: TokenPayload,
        @Body() config: UpdateSessionConfigDto,
    ): Promise<SessionStorageConfig> {
        return this.sessionConfigService.updateConfig(token.entity!.id, config);
    }

    /**
     * Reset the session storage configuration to defaults.
     */
    @Delete()
    @ApiOperation({
        summary: "Reset session storage configuration",
        description:
            "Resets the session storage configuration to use global defaults.",
    })
    @ApiResponse({
        status: 204,
        description: "Configuration reset successfully",
    })
    @HttpCode(204)
    resetConfig(@Token() token: TokenPayload): Promise<void> {
        return this.sessionConfigService.resetConfig(token.entity!.id);
    }
}
