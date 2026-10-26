import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
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

const fixtures = resolve(__dirname, "../fixtures/haip");
const accessKeyChain = "2f71c235-87e2-43c9-b572-739a3164ce95";
const attestationKeyChain = "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad";
const detachTenants = ["detach-unchanged", "detach-stale", "detach-reset"];

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

describe("default access key chain in a startup folder import", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    const originalEnvironment = {
        CONFIG_FOLDER: process.env.CONFIG_FOLDER,
        CONFIG_IMPORT_MODE: process.env.CONFIG_IMPORT_MODE,
        FOLDER: process.env.FOLDER,
    };

    const tenant = (id: string) =>
        app.get(DataSource).getRepository(TenantEntity).findOneBy({ id });

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-default-access-"));
        const configRoot = join(runtimeFolder, "config");
        mkdirSync(configRoot);

        // A bare info.json with the field is read as Tenant v3.
        const named = join(configRoot, "default-named");
        cpSync(fixtures, named, { recursive: true });
        writeFileSync(
            join(named, "info.json"),
            JSON.stringify({
                name: "Default named",
                defaultKeyChains: { access: accessKeyChain },
            }),
        );

        // A Tenant v2 file of a development build of 10.0.
        const v2 = join(configRoot, "default-v2");
        mkdirSync(join(v2, "key-chains"), { recursive: true });
        cpSync(
            join(fixtures, "key-chains/access.json"),
            join(v2, "key-chains/access.json"),
        );
        writeFileSync(
            join(v2, "info.json"),
            JSON.stringify({
                $schema: schemaUrl("Tenant", 2),
                metadata: { generation: 1 },
                spec: {
                    name: "Default v2",
                    defaultAccessKeyChainId: accessKeyChain,
                },
            }),
        );

        const wrongUsage = join(configRoot, "default-wrong-usage");
        mkdirSync(join(wrongUsage, "key-chains"), { recursive: true });
        cpSync(
            join(fixtures, "key-chains/attestation.json"),
            join(wrongUsage, "key-chains/attestation.json"),
        );
        writeFileSync(
            join(wrongUsage, "info.json"),
            JSON.stringify({
                name: "Default with wrong usage",
                defaultKeyChains: { access: attestationKeyChain },
            }),
        );

        // Tenants whose settings are detached or reset by the tests below.
        for (const id of detachTenants) {
            const folder = join(configRoot, id);
            mkdirSync(join(folder, "key-chains"), { recursive: true });
            cpSync(
                join(fixtures, "key-chains/access.json"),
                join(folder, "key-chains/access.json"),
            );
            writeFileSync(
                join(folder, "info.json"),
                JSON.stringify({
                    name: id,
                    defaultKeyChains: { access: accessKeyChain },
                }),
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

    it("sets the default once the key chain of the folder is imported", async () => {
        expect((await tenant("default-named"))?.defaultKeyChains).toEqual({
            access: accessKeyChain,
        });
    });

    it("moves the default of a Tenant v2 file into defaultKeyChains", async () => {
        expect((await tenant("default-v2"))?.defaultKeyChains).toEqual({
            access: accessKeyChain,
        });
    });

    it("stores no default that names a key chain of another usage type", async () => {
        const stored = await tenant("default-wrong-usage");

        // The tenant and its key chain are imported; only the default is refused.
        expect(stored?.name).toBe("Default with wrong usage");
        expect(stored?.defaultKeyChains ?? null).toBeNull();
    });

    describe("tenant settings detached from the folder", () => {
        let mode: MockInstance;
        let warn: MockInstance;

        // A restart in upsert mode applies info.json to an existing tenant.
        const restart = async (tenantId: string) => {
            const tenants = app.get(TenantService);
            await expect(tenants.setupTenant(tenantId)).resolves.toBe(true);
            await tenants.finishTenantSetup(tenantId);
        };
        const ownershipOf = (tenantId: string) =>
            app.get(ConfigOwnershipService).get(tenantId, "Tenant", "tenant");
        const warnings = () => warn.mock.calls.map(([message]) => message);
        const removeDefault = (tenantId: string) =>
            app
                .get(DataSource)
                .getRepository(TenantEntity)
                .update({ id: tenantId }, { defaultKeyChains: null as any });

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
            // Changed without a new generation, so only the detached state
            // keeps the file from applying again.
            await removeDefault("detach-unchanged");

            await restart("detach-unchanged");

            expect(
                (await tenant("detach-unchanged"))?.defaultKeyChains ?? null,
            ).toBeNull();
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
            await removeDefault("detach-stale");
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

            expect(
                (await tenant("detach-stale"))?.defaultKeyChains ?? null,
            ).toBeNull();
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
            // Detach and remove the default, as the UI would.
            await ownership.detach("detach-reset", "Tenant", "tenant");
            await app
                .get(TenantService)
                .updateTenant("detach-reset", { defaultKeyChains: null });
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

            expect((await tenant("detach-reset"))?.defaultKeyChains).toEqual({
                access: accessKeyChain,
            });
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
});
