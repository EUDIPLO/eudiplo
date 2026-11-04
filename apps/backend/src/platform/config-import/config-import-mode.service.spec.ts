import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { ConfigImportModeService } from "./config-import-mode.service.js";

describe("ConfigImportModeService", () => {
    it.each(["disabled", "create", "upsert", "replace"] as const)(
        "uses explicit %s mode",
        (mode) => {
            const service = createService({ CONFIG_IMPORT_MODE: mode });
            expect(service.resolve()).toBe(mode);
        },
    );

    it("is disabled without CONFIG_IMPORT_MODE", () => {
        expect(createService({}).resolve()).toBe("disabled");
    });

    it("ignores the removed CONFIG_IMPORT and CONFIG_IMPORT_FORCE", () => {
        expect(
            createService({
                CONFIG_IMPORT: true,
                CONFIG_IMPORT_FORCE: true,
            }).resolve(),
        ).toBe("disabled");
    });
});

function createService(
    values: Record<string, unknown>,
): ConfigImportModeService {
    const config = {
        get: (key: string) => values[key],
    } as ConfigService;
    return new ConfigImportModeService(config);
}
