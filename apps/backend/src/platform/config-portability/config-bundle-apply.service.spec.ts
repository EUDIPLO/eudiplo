import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { describe, expect, it, vi } from "vitest";
import { ConfigBundleApplyService } from "./config-bundle-apply.service.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
} from "./config-resource.types.js";

describe("ConfigBundleApplyService", () => {
    it("does not apply or claim ownership of resources skipped in create mode", async () => {
        const plan: ConfigImportPlan = {
            tenantId: "tenant-a",
            mode: "create",
            applicable: true,
            items: [
                {
                    kind: "Client",
                    id: "existing",
                    action: "skip",
                    sourceVersion: "eudiplo.dev/client/v1",
                    targetVersion: "eudiplo.dev/client/v1",
                    migrations: [],
                    issues: [],
                },
            ],
            issues: [],
        };
        const bundle: ConfigBundle = {
            manifest: {
                format: "eudiplo.config-bundle",
                formatVersion: 1,
                sourceVersion: "test",
                exportedAt: new Date(0).toISOString(),
                tenant: "tenant-a",
                resources: [],
                assets: [],
                requirements: [],
                warnings: [],
            },
            documents: [
                {
                    $schema: schemaUrl("Client"),
                    metadata: { generation: 1 },
                    spec: { clientId: "existing" },
                },
            ],
            assets: [],
        };
        const service = Object.create(
            ConfigBundleApplyService.prototype,
        ) as any;
        service.journal = {
            run: async (_tenant: string, _mode: string, execute: any) =>
                execute({ id: "run-1", operations: [] }),
            checkpoint: vi.fn(),
        };
        service.bundleService = { plan: vi.fn().mockResolvedValue(plan) };
        service.filesService = { saveImportedAsset: vi.fn() };
        service.migrationService = {
            upgrade: vi.fn((document) => ({ document })),
        };
        service.ownershipService = {
            markApplied: vi.fn(),
            remove: vi.fn(),
        };

        await expect(
            service.apply(
                "tenant-a",
                bundle,
                "create",
                "folder:/config/tenant-a",
            ),
        ).resolves.toMatchObject(plan);
        expect(service.ownershipService.markApplied).not.toHaveBeenCalled();
    });
});

function setupApply(
    actions: Array<{
        id: string;
        action: "create" | "unchanged" | "delete";
        metadataChanged?: boolean;
    }>,
) {
    const plan: ConfigImportPlan = {
        tenantId: "tenant-a",
        mode: "upsert",
        applicable: true,
        issues: [],
        items: actions.map((item) => ({
            ...item,
            kind: "Client",
            sourceVersion: "eudiplo.dev/client/v1",
            targetVersion: "eudiplo.dev/client/v1",
            migrations: [],
            issues: [],
        })),
    };
    const bundle = {
        manifest: { tenant: "tenant-a" },
        documents: actions
            .filter((item) => item.action !== "delete")
            .map((item) => ({
                $schema: schemaUrl("Client"),
                metadata: {},
                spec: { clientId: item.id },
            })),
        assets: [],
    } as unknown as ConfigBundle;
    const service = Object.create(ConfigBundleApplyService.prototype) as any;
    service.journal = {
        run: async (_tenant: string, _mode: string, execute: any) =>
            execute({ id: "run-1", operations: [] }),
        checkpoint: vi.fn(),
    };
    service.bundleService = { plan: vi.fn().mockResolvedValue(plan) };
    service.filesService = { saveImportedAsset: vi.fn() };
    service.migrationService = { upgrade: vi.fn((document) => ({ document })) };
    service.ownershipService = { markApplied: vi.fn(), remove: vi.fn() };
    service.resourceRegistry = { get: () => ({ importPhase: 1 }) };
    service.applyDocument = vi.fn();
    service.deleteDocument = vi.fn();
    return { service, bundle, plan };
}

describe("apply reconciliation and recovery", () => {
    it("does not rewrite unchanged resources or their unchanged metadata", async () => {
        const { service, bundle, plan } = setupApply([
            { id: "same", action: "unchanged", metadataChanged: false },
        ]);
        expect(await service.apply("tenant-a", bundle, "upsert")).toMatchObject(
            plan,
        );
        expect(service.applyDocument).not.toHaveBeenCalled();
        expect(service.ownershipService.markApplied).not.toHaveBeenCalled();
    });
    it("claims ownership of matching resources without writing them", async () => {
        const { service, bundle } = setupApply([
            { id: "same", action: "unchanged", metadataChanged: true },
        ]);
        await service.apply("tenant-a", bundle, "upsert");
        expect(service.applyDocument).not.toHaveBeenCalled();
        expect(service.ownershipService.markApplied).toHaveBeenCalledWith(
            expect.objectContaining({
                resourceId: "same",
                ownership: "file-managed",
            }),
            undefined,
            undefined,
        );
    });
    it("reports partial completion and preserves generated secrets when a later operation fails", async () => {
        const { service, bundle } = setupApply([
            { id: "first", action: "create" },
            { id: "failed", action: "create" },
            { id: "pending", action: "delete" },
        ]);
        const secret = {
            kind: "Client",
            id: "first",
            path: "/spec/secret",
            value: "generated-once",
        };
        service.applyDocument
            .mockResolvedValueOnce(secret)
            .mockRejectedValueOnce(
                new Error("provider error containing a private credential"),
            );
        let response: any;
        try {
            await service.apply("tenant-a", bundle, "upsert");
        } catch (error: any) {
            response = error.getResponse();
        }
        expect(response.code).toBe("CONFIG_APPLY_FAILED");
        expect(response.operations).toEqual([
            {
                stage: "resource",
                kind: "Client",
                id: "first",
                status: "completed",
            },
            {
                stage: "ownership",
                kind: "Client",
                id: "first",
                status: "completed",
            },
            {
                stage: "resource",
                kind: "Client",
                id: "failed",
                status: "failed",
            },
            {
                stage: "ownership",
                kind: "Client",
                id: "failed",
                status: "pending",
            },
            {
                stage: "delete",
                kind: "Client",
                id: "pending",
                status: "pending",
            },
            {
                stage: "delete-ownership",
                kind: "Client",
                id: "pending",
                status: "pending",
            },
        ]);
        expect(response.generatedSecrets).toEqual([secret]);
        expect(JSON.stringify(response)).not.toContain("private credential");
        expect(service.deleteDocument).not.toHaveBeenCalled();
    });
    it("distinguishes a successful resource write from a failed ownership write", async () => {
        const { service, bundle } = setupApply([
            { id: "first", action: "create" },
        ]);
        service.ownershipService.markApplied.mockRejectedValue(
            new Error("database failure"),
        );
        try {
            await service.apply("tenant-a", bundle, "upsert");
            throw new Error("Expected apply failure");
        } catch (error: any) {
            expect(
                error
                    .getResponse()
                    .operations.map((operation: any) => operation.status),
            ).toEqual(["completed", "failed"]);
        }
    });
});

describe("reviewed plans and replacement failures", () => {
    it("rejects a stale reviewed plan before any resource, asset or ownership write", async () => {
        const { service, bundle, plan } = setupApply([
            { id: "new", action: "create" },
        ]);
        plan.planFingerprint = "current";
        await expect(
            service.apply("tenant-a", bundle, "upsert", undefined, "reviewed"),
        ).rejects.toMatchObject({
            response: expect.objectContaining({ code: "CONFIG_PLAN_STALE" }),
        });
        expect(service.applyDocument).not.toHaveBeenCalled();
        expect(service.filesService.saveImportedAsset).not.toHaveBeenCalled();
        expect(service.ownershipService.markApplied).not.toHaveBeenCalled();
    });
    it("keeps the previous private key when replacement preparation fails", async () => {
        const service = Object.create(
            ConfigBundleApplyService.prototype,
        ) as any;
        service.repos = { keyChains: { delete: vi.fn(), save: vi.fn() } };
        service.keyChainService = {
            importKeyChain: vi
                .fn()
                .mockRejectedValue(new Error("invalid replacement")),
        };
        service.migrationService = {
            unwrapForLegacyImporter: (document: any) => document.spec,
        };
        await expect(
            service.applyKeyChain("tenant", {
                metadata: { id: "key" },
                spec: { keySource: { type: "private-jwk", jwk: {} } },
            }),
        ).rejects.toThrow("invalid replacement");
        expect(service.repos.keyChains.delete).not.toHaveBeenCalled();
        expect(service.repos.keyChains.save).not.toHaveBeenCalled();
    });
    it("uploads only assets marked as changed by the plan", async () => {
        const { service, bundle, plan } = setupApply([]);
        bundle.assets = [
            { path: "images/same.png", data: "", sha256: "same" },
            { path: "images/new.png", data: "", sha256: "new" },
        ];
        plan.assets = [
            { path: "images/same.png", action: "unchanged", sha256: "same" },
            { path: "images/new.png", action: "create", sha256: "new" },
        ];
        await service.apply("tenant", bundle, "upsert");
        expect(service.filesService.saveImportedAsset).toHaveBeenCalledTimes(1);
        expect(service.filesService.saveImportedAsset.mock.calls[0][1]).toBe(
            "new.png",
        );
    });
});
