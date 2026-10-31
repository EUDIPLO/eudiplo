import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { ConfigOwnershipBootstrapService } from "./config-ownership-bootstrap.service.js";

describe("ConfigOwnershipBootstrapService", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it("skips a tenant ID that is no folder name and records the others", async () => {
        vi.mocked(existsSync).mockImplementation(
            (path) => String(path) === "/config/tenant-a/kms.json",
        );
        vi.mocked(readFileSync).mockReturnValue(
            Buffer.from(JSON.stringify({ providers: [] })),
        );
        const ownershipService = {
            findStored: vi.fn().mockResolvedValue(null),
            markApplied: vi.fn().mockResolvedValue(undefined),
        };
        const service = new ConfigOwnershipBootstrapService(
            { get: vi.fn(() => "/config") } as any,
            ownershipService as any,
            {
                isDocument: vi.fn(() => false),
                wrapLegacy: vi.fn(() => ({ metadata: {} })),
            } as any,
            { resolve: vi.fn(() => "enabled") } as any,
            {
                find: vi
                    .fn()
                    .mockResolvedValue([
                        { id: "x/../victim" },
                        { id: "tenant-a" },
                    ]),
            } as any,
        );

        const warn = vi
            .spyOn(Logger.prototype, "warn")
            .mockImplementation(() => undefined);

        await service.onApplicationBootstrap();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "[x/../victim] The tenant ID is not a folder name",
            ),
        );
        expect(existsSync).toHaveBeenCalledTimes(1);
        expect(existsSync).toHaveBeenCalledWith("/config/tenant-a/kms.json");
        expect(ownershipService.markApplied).toHaveBeenCalledTimes(1);
        expect(ownershipService.markApplied).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: "tenant-a" }),
        );
    });
});
