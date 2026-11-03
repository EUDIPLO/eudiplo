import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ConfigImportMode } from "../config-portability/config-resource.types.js";

export type StartupConfigImportMode = "disabled" | ConfigImportMode;

@Injectable()
export class ConfigImportModeService {
    constructor(private readonly configService: ConfigService) {}

    resolve(): StartupConfigImportMode {
        return (
            this.configService.get<StartupConfigImportMode>(
                "CONFIG_IMPORT_MODE",
            ) ?? "disabled"
        );
    }
}
