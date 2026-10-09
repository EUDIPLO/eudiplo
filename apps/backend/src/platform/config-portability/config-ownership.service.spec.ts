import { describe, expect, it, vi } from "vitest";
import { ConfigOwnershipService } from "./config-ownership.service.js";

describe("ConfigOwnershipService", () => {
    it("finds resources managed by the startup folder and legacy file sources", async () => {
        const repository = {
            find: vi.fn().mockResolvedValue([
                {
                    tenantId: "tenant-a",
                    kind: "Client",
                    resourceId: "current",
                    ownership: "file-managed",
                    source: "folder:/config/tenant-a",
                },
                {
                    tenantId: "tenant-a",
                    kind: "KeyChain",
                    resourceId: "legacy",
                    ownership: "file-managed",
                    source: "/config/tenant-a/key-chains/legacy.json",
                },
                {
                    tenantId: "tenant-a",
                    kind: "Client",
                    resourceId: "other-folder",
                    ownership: "file-managed",
                    source: "folder:/config/tenant-b",
                },
                {
                    tenantId: "tenant-a",
                    kind: "Client",
                    resourceId: "unmanaged",
                    ownership: "unmanaged",
                    source: "/config/tenant-a/clients/unmanaged.json",
                },
            ]),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.listManagedBySourceScope(
                "tenant-a",
                "folder:/config/tenant-a",
            ),
        ).resolves.toMatchObject([
            { resourceId: "current" },
            { resourceId: "legacy" },
        ]);
    });

    it("uses exact source matching for imported bundles", async () => {
        const repository = {
            find: vi.fn().mockResolvedValue([
                {
                    tenantId: "tenant-a",
                    kind: "Client",
                    resourceId: "included",
                    ownership: "file-managed",
                    source: "bundle:source-a",
                },
                {
                    tenantId: "tenant-a",
                    kind: "Client",
                    resourceId: "excluded",
                    ownership: "file-managed",
                    source: "bundle:source-b",
                },
            ]),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.listManagedBySourceScope("tenant-a", "bundle:source-a"),
        ).resolves.toMatchObject([{ resourceId: "included" }]);
    });

    it("rejects a stale file generation", async () => {
        const repository = {
            findOneBy: vi.fn().mockResolvedValue({
                tenantId: "tenant-a",
                kind: "CredentialConfig",
                resourceId: "pid",
                ownership: "unmanaged",
                generation: 4,
            }),
            save: vi.fn(),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.markApplied({
                tenantId: "tenant-a",
                kind: "CredentialConfig",
                resourceId: "pid",
                ownership: "file-managed",
                generation: 3,
                source: "credentials/pid.json",
            }),
        ).rejects.toThrow("stale generation 3; stored generation is 4");
        expect(repository.save).not.toHaveBeenCalled();
    });

    it("advances the generation of an API-managed resource", async () => {
        const stored = {
            tenantId: "tenant-a",
            kind: "Client",
            resourceId: "automation",
            ownership: "unmanaged",
            generation: 2,
        };
        const repository = {
            findOneBy: vi.fn().mockResolvedValue(stored),
            save: vi.fn(async (value) => value),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.recordApiMutation(
                "tenant-a",
                "Client",
                "automation",
                false,
            ),
        ).resolves.toMatchObject({
            ownership: "unmanaged",
            generation: 3,
        });
    });

    it("keeps the former source when detaching", async () => {
        const repository = {
            findOneBy: vi.fn().mockResolvedValue({
                tenantId: "tenant-a",
                kind: "RegistrarConfig",
                resourceId: "registrar",
                ownership: "file-managed",
                generation: 5,
                source: "folder:/config/tenant-a",
                sourceHash: "abc",
            }),
            save: vi.fn(async (value) => value),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.detach("tenant-a", "RegistrarConfig", "registrar"),
        ).resolves.toMatchObject({
            ownership: "detached",
            source: "folder:/config/tenant-a",
            sourceHash: undefined,
            generation: 5,
        });
    });

    it("rejects detaching a resource that is not file-managed", async () => {
        const repository = {
            findOneBy: vi.fn().mockResolvedValue(null),
            create: vi.fn((value) => value),
            save: vi.fn(),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.detach("tenant-a", "Client", "automation"),
        ).rejects.toThrow("is not file-managed");
        expect(repository.save).not.toHaveBeenCalled();
    });

    it("keeps a detached resource detached when it is changed through the API", async () => {
        const repository = {
            findOneBy: vi.fn().mockResolvedValue({
                tenantId: "tenant-a",
                kind: "IssuanceConfig",
                resourceId: "issuance",
                ownership: "detached",
                generation: 5,
                source: "folder:/config/tenant-a",
            }),
            save: vi.fn(async (value) => value),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.recordApiMutation(
                "tenant-a",
                "IssuanceConfig",
                "issuance",
                false,
            ),
        ).resolves.toMatchObject({
            ownership: "detached",
            source: "folder:/config/tenant-a",
            generation: 6,
        });
    });

    it("resets the generation when reattaching", async () => {
        const repository = {
            findOneBy: vi.fn().mockResolvedValue({
                tenantId: "tenant-a",
                kind: "IssuanceConfig",
                resourceId: "issuance",
                ownership: "detached",
                generation: 10,
                source: "folder:/config/tenant-a",
            }),
            save: vi.fn(async (value) => value),
        };
        const service = new ConfigOwnershipService(repository as any);

        await expect(
            service.markApplied(
                {
                    tenantId: "tenant-a",
                    kind: "IssuanceConfig",
                    resourceId: "issuance",
                    ownership: "file-managed",
                    generation: 6,
                    source: "folder:/config/tenant-a",
                },
                undefined,
                true,
            ),
        ).resolves.toMatchObject({ ownership: "file-managed", generation: 6 });
    });
});
