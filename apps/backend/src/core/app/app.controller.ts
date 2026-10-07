import { Controller, Get, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    ApiOperation,
    ApiResponse,
    ApiSecurity,
    ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../auth/auth.guard.js";
import { ConfigImportModeService } from "../../platform/config-import/config-import-mode.service.js";
import { FrontendConfigResponseDto } from "./dto/frontend-config-response.dto.js";
import { ServiceInfoResponseDto } from "./dto/service-info-response.dto.js";
import { VersionResponseDto } from "./dto/version-response.dto.js";

/**
 * Main application controller
 */
@ApiTags("App")
@Controller()
export class AppController {
    constructor(
        private readonly configService: ConfigService,
        private readonly configImportModeService: ConfigImportModeService,
    ) {}

    /**
     * Main endpoint providing service info
     */
    @Get()
    @ApiOperation({ summary: "Get service info" })
    @ApiResponse({
        status: 200,
        description: "Service info",
        type: ServiceInfoResponseDto,
    })
    main(): ServiceInfoResponseDto {
        return {
            service: "EUDIPLO",
            documentation: "https://docs.eudiplo.dev",
        };
    }

    /**
     * Returns the running service version. Requires authentication.
     */
    @Get("version")
    @UseGuards(JwtAuthGuard)
    @ApiSecurity("oauth2")
    @ApiOperation({ summary: "Get service version" })
    @ApiResponse({
        status: 200,
        description: "Service version info",
        type: VersionResponseDto,
    })
    getVersion(): VersionResponseDto {
        return {
            version: process.env.VERSION ?? "main",
            revision: process.env.REVISION || undefined,
        };
    }

    /**
     * Returns runtime configuration for the frontend client.
     */
    @Get("frontend-config")
    @UseGuards(JwtAuthGuard)
    @ApiSecurity("oauth2")
    @ApiOperation({ summary: "Get frontend runtime configuration" })
    @ApiResponse({
        status: 200,
        description: "Frontend configuration",
        type: FrontendConfigResponseDto,
    })
    getFrontendConfig(): FrontendConfigResponseDto {
        const grafanaUrl = this.configService.get<string>("GRAFANA_URL");
        return {
            grafana: {
                url: grafanaUrl || undefined,
                tempoUid: this.configService.get<string>(
                    "GRAFANA_DATASOURCE_TEMPO_UID",
                    "tempo",
                ),
                lokiUid: this.configService.get<string>(
                    "GRAFANA_DATASOURCE_LOKI_UID",
                    "loki",
                ),
            },
            configImportMode: this.configImportModeService.resolve(),
            publicUrl: this.configService.getOrThrow<string>("PUBLIC_URL"),
        };
    }
}
