import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { AuthSettings } from "../../auth/auth-settings.js";
import type { ConfigImportModeService } from "../../platform/config-import/config-import-mode.service.js";
import { AppController } from "./app.controller.js";

function createController(
    settings: Record<string, string>,
    authSettings: AuthSettings = { mode: "builtin" },
) {
    const configService = {
        get: (key: string, defaultValue?: string) =>
            settings[key] ?? defaultValue,
        getOrThrow: (key: string) => {
            if (settings[key] === undefined) {
                throw new TypeError(`Configuration key "${key}" missing`);
            }
            return settings[key];
        },
    } as unknown as ConfigService;
    const configImportModeService = {
        resolve: () => "disabled",
    } as unknown as ConfigImportModeService;
    return new AppController(
        configService,
        configImportModeService,
        authSettings,
    );
}

describe("AppController", () => {
    it("returns the frontend configuration with the public URL", () => {
        const controller = createController({
            PUBLIC_URL: "https://eudiplo.example.com",
        });

        expect(controller.getFrontendConfig()).toEqual({
            grafana: { url: undefined, tempoUid: "tempo", lokiUid: "loki" },
            configImportMode: "disabled",
            publicUrl: "https://eudiplo.example.com",
            authMode: "builtin",
        });
    });

    it("reports the authentication mode, so the web client hides what it cannot manage", () => {
        const controller = createController(
            { PUBLIC_URL: "https://eudiplo.example.com" },
            { mode: "generic" } as AuthSettings,
        );

        expect(controller.getFrontendConfig().authMode).toBe("generic");
    });
});
