import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({ providers: [] })),
    rmSync: vi.fn(),
}));

vi.mock("@eudiplo/config-format/config-io.js", () => ({
    atomicWriteFileSync: vi.fn(),
}));

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { atomicWriteFileSync } from "@eudiplo/config-format/config-io.js";
import { KmsTenantConfigService } from "./kms-tenant-config.service.js";

describe("KmsTenantConfigService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function createService() {
        const configService = {
            get: vi.fn((key: string) =>
                key === "CONFIG_FOLDER" ? "/config" : undefined,
            ),
        };
        return new KmsTenantConfigService(
            configService as any,
            {
                getConfig: vi.fn(),
                invalidateTenantCache: vi.fn(),
            } as any,
            { invalidateTenant: vi.fn() } as any,
        );
    }

    const config = { providers: [{ id: "db", type: "db" as const }] };

    it.each(["../outside", "x/../victim"])(
        "does not touch another folder's kms.json for the tenant ID %j",
        (tenantId) => {
            const service = createService();

            // Reads, such as bundle exports, see no tenant file.
            expect(service.getTenantConfig(tenantId)).toBeNull();
            expect(() => service.saveTenantConfig(tenantId, config)).toThrow(
                /not a folder name/,
            );
            expect(() => service.updateTenantConfig(tenantId, config)).toThrow(
                /not a folder name/,
            );
            expect(() => service.deleteTenantConfig(tenantId)).toThrow(
                /not a folder name/,
            );

            expect(existsSync).not.toHaveBeenCalled();
            expect(readFileSync).not.toHaveBeenCalled();
            expect(mkdirSync).not.toHaveBeenCalled();
            expect(atomicWriteFileSync).not.toHaveBeenCalled();
            expect(rmSync).not.toHaveBeenCalled();
        },
    );

    it("says whether a tenant can store a kms.json", () => {
        const service = createService();

        expect(service.canStoreTenantConfig("tenant-a")).toBe(true);
        expect(service.canStoreTenantConfig("x/../victim")).toBe(false);
        // Without CONFIG_FOLDER, saving reports the missing folder itself.
        expect(
            new KmsTenantConfigService(
                { get: vi.fn(() => undefined) } as any,
                {} as any,
                {} as any,
            ).canStoreTenantConfig("x/../victim"),
        ).toBe(true);
    });

    it("writes and deletes the tenant's own kms.json", () => {
        const service = createService();

        service.saveTenantConfig("tenant-a", config);
        service.deleteTenantConfig("tenant-a");

        expect(atomicWriteFileSync).toHaveBeenCalledWith(
            "/config/tenant-a/kms.json",
            expect.any(String),
        );
        expect(rmSync).toHaveBeenCalledWith("/config/tenant-a/kms.json");
    });
});
