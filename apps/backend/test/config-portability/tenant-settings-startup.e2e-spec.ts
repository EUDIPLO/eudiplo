import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    type MockInstance,
    vi,
} from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { TenantService } from "../../src/auth/tenant/tenant.service.js";
import { ConfigImportModeService } from "../../src/platform/config-import/config-import-mode.service.js";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { ConfigOwnershipService } from "../../src/platform/config-portability/config-ownership.service.js";
import { ConfigResourceMetadataEntity } from "../../src/platform/config-portability/entities/config-resource-metadata.entity.js";

// Kept apart from test/utils.ts: importing it before the environment is set
// turns the startup import off.

const tenants = ["detach-unchanged", "detach-stale", "detach-reset"];
const description = "Description from info.json";

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe("tenant settings detached from the startup folder", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    let mode: MockInstance;
    let warn: MockInstance;
    const originalEnvironment = {
        CONFIG_FOLDER: process.env.CONFIG_FOLDER,
        CONFIG_IMPORT_MODE: process.env.CONFIG_IMPORT_MODE,
        FOLDER: process.env.FOLDER,
    };

    const tenant = (id: string) =>
        app.get(DataSource).getRepository(TenantEntity).findOneBy({ id });
    // A restart in upsert mode applies info.json to an existing tenant.
    const restart = (tenantId: string) =>
        expect(app.get(TenantService).setupTenant(tenantId)).resolves.toBe(
            true,
        );
    const ownershipOf = (tenantId: string) =>
        app.get(ConfigOwnershipService).get(tenantId, "Tenant", "tenant");
    const warnings = () => warn.mock.calls.map(([message]) => message);
    const removeDescription = (tenantId: string) =>
        app
            .get(DataSource)
            .getRepository(TenantEntity)
            .update({ id: tenantId }, { description: null as any });

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-tenant-settings-"));
        const configRoot = join(runtimeFolder, "config");
        for (const id of tenants) {
            mkdirSync(join(configRoot, id), { recursive: true });
            writeFileSync(
                join(configRoot, id, "info.json"),
                JSON.stringify({ name: id, description }),
            );
        }

        process.env.CONFIG_FOLDER = configRoot;
        process.env.CONFIG_IMPORT_MODE = "create";
        process.env.FOLDER = runtimeFolder;

        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
    }, 30_000);

    afterAll(async () => {
        await app?.close();
        rmSync(runtimeFolder, { recursive: true, force: true });
        restoreEnvironment("CONFIG_FOLDER", originalEnvironment.CONFIG_FOLDER);
        restoreEnvironment(
            "CONFIG_IMPORT_MODE",
            originalEnvironment.CONFIG_IMPORT_MODE,
        );
        restoreEnvironment("FOLDER", originalEnvironment.FOLDER);
    });

    beforeEach(() => {
        mode = vi
            .spyOn(app.get(ConfigImportModeService), "resolve")
            .mockReturnValue("upsert");
        warn = vi.spyOn(Logger.prototype, "warn");
    });

    afterEach(() => {
        mode.mockRestore();
        warn.mockRestore();
    });

    it("skips info.json at startup while the settings are detached", async () => {
        await app
            .get(ConfigOwnershipService)
            .detach("detach-unchanged", "Tenant", "tenant");
        // Changed without a new generation, so only the detached state keeps
        // the file from applying again.
        await removeDescription("detach-unchanged");

        await restart("detach-unchanged");

        expect((await tenant("detach-unchanged"))?.description).toBeNull();
        expect(await ownershipOf("detach-unchanged")).toMatchObject({
            ownership: "detached",
            generation: 1,
        });
        expect(warnings()).toContainEqual(
            expect.stringContaining(
                "Skipped Tenant 'tenant' (RESOURCE_DETACHED)",
            ),
        );
    });

    it("skips an info.json older than settings changed through the API and keeps the tenant import going", async () => {
        // Settings changed before the detached state existed are plain
        // unmanaged with a newer generation.
        await removeDescription("detach-stale");
        await app
            .get(DataSource)
            .getRepository(ConfigResourceMetadataEntity)
            .update(
                {
                    tenantId: "detach-stale",
                    kind: "Tenant",
                    resourceId: "tenant",
                },
                {
                    ownership: "unmanaged",
                    source: null as any,
                    generation: 2,
                },
            );

        await restart("detach-stale");

        expect((await tenant("detach-stale"))?.description).toBeNull();
        expect(await ownershipOf("detach-stale")).toMatchObject({
            ownership: "unmanaged",
            generation: 2,
        });
        expect(warnings()).toContainEqual(
            expect.stringContaining(
                "Skipped Tenant 'tenant' (STALE_GENERATION)",
            ),
        );
    });

    it("resets detached settings to info.json, which later startups apply again", async () => {
        const ownership = app.get(ConfigOwnershipService);
        const folder = app.get(ConfigFolderBundleService);
        // Detach and remove the description, as the UI would.
        await ownership.detach("detach-reset", "Tenant", "tenant");
        await app
            .get(TenantService)
            .updateTenant("detach-reset", { description: null });
        await ownership.recordApiMutation(
            "detach-reset",
            "Tenant",
            "tenant",
            false,
        );

        const plan = await folder.planReattach(
            "detach-reset",
            "Tenant",
            "tenant",
        );
        expect(plan.applicable, JSON.stringify(plan.issues)).toBe(true);
        expect(plan.items).toEqual([
            expect.objectContaining({ kind: "Tenant", action: "update" }),
        ]);
        await folder.reattach(
            "detach-reset",
            "Tenant",
            "tenant",
            plan.planFingerprint!,
        );

        expect((await tenant("detach-reset"))?.description).toBe(description);
        expect(await ownershipOf("detach-reset")).toMatchObject({
            ownership: "file-managed",
            generation: 1,
        });
        const { lastAppliedAt } = await ownershipOf("detach-reset");
        await restart("detach-reset");
        expect(warnings().join("\n")).not.toContain("Skipped Tenant");
        const reapplied = await ownershipOf("detach-reset");
        expect(reapplied).toMatchObject({ ownership: "file-managed" });
        expect(reapplied.sourceHash).toBeTruthy();
        expect(reapplied.lastAppliedAt!.getTime()).toBeGreaterThanOrEqual(
            lastAppliedAt!.getTime(),
        );
    });
});
