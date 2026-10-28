import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { KeyChainEntity } from "../../src/crypto/key/entities/key-chain.entity.js";
import { ConfigImportModeService } from "../../src/platform/config-import/config-import-mode.service.js";
import { ConfigBundleService } from "../../src/platform/config-portability/config-bundle.service.js";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { ConfigOwnershipService } from "../../src/platform/config-portability/config-ownership.service.js";

// Kept apart from test/utils.ts: importing it before the environment is set
// turns the startup import off.

const fixtures = resolve(__dirname, "../fixtures/haip");
const accessKeyChain = "2f71c235-87e2-43c9-b572-739a3164ce95";
const attestationKeyChain = "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad";

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

/** A tenant folder with one fixture key chain and the given files. */
function tenantFolder(
    configRoot: string,
    id: string,
    keyChain: "access" | "attestation",
    files: Record<string, unknown>,
): void {
    const folder = join(configRoot, id);
    mkdirSync(join(folder, "key-chains"), { recursive: true });
    cpSync(
        join(fixtures, `key-chains/${keyChain}.json`),
        join(folder, `key-chains/${keyChain}.json`),
    );
    for (const [file, content] of Object.entries(files))
        writeFileSync(join(folder, file), JSON.stringify(content));
}

describe("default access key chain in a startup folder import", () => {
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
    const keyChainCount = (tenantId: string) =>
        app.get(DataSource).getRepository(KeyChainEntity).countBy({ tenantId });
    const warnings = () =>
        warn.mock.calls.map(([message]) => String(message)).join("\n");

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-default-access-"));
        const configRoot = join(runtimeFolder, "config");
        mkdirSync(configRoot);

        // The folder creates the key chain the defaults name.
        const named = join(configRoot, "default-named");
        cpSync(fixtures, named, { recursive: true });
        writeFileSync(
            join(named, "key-chain-defaults.json"),
            JSON.stringify({ access: accessKeyChain }),
        );

        // An info.json of a development build of 10.0.
        tenantFolder(configRoot, "default-in-info", "access", {
            "info.json": {
                name: "Default in info.json",
                defaultKeyChains: { access: accessKeyChain },
            },
        });

        tenantFolder(configRoot, "default-wrong-usage", "attestation", {
            "info.json": { name: "Default with wrong usage" },
            "key-chain-defaults.json": { access: attestationKeyChain },
        });

        tenantFolder(configRoot, "default-detach", "access", {
            "info.json": { name: "Default detached" },
            "key-chain-defaults.json": { access: accessKeyChain },
        });

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

    it("sets the default from key-chain-defaults.json when the folder creates the key chain", async () => {
        expect((await tenant("default-named"))?.defaultKeyChains).toEqual({
            access: accessKeyChain,
        });
        expect(
            await app
                .get(ConfigOwnershipService)
                .get("default-named", "KeyChainDefaults", "defaults"),
        ).toMatchObject({ ownership: "file-managed", generation: 1 });
    });

    it("drops defaultKeyChains from info.json with a warning", async () => {
        const stored = await tenant("default-in-info");

        expect(stored?.name).toBe("Default in info.json");
        expect(stored?.defaultKeyChains ?? null).toBeNull();
        expect(await keyChainCount("default-in-info")).toBeGreaterThan(0);

        // Each restart applies info.json again and says so.
        await expect(
            app.get(TenantService).setupTenant("default-in-info"),
        ).resolves.toBe(true);
        expect(warnings()).toContain(
            "[default-in-info] info.json/spec/defaultKeyChains: DEFAULT_KEY_CHAINS_MOVED",
        );
    });

    it("blocks the folder import when the default has another usage type", async () => {
        const stored = await tenant("default-wrong-usage");

        // info.json is applied before the folder plan, which is refused as a
        // whole, so the key chain is not imported either.
        expect(stored?.name).toBe("Default with wrong usage");
        expect(stored?.defaultKeyChains ?? null).toBeNull();
        expect(
            await app.get(DataSource).getRepository(KeyChainEntity).countBy({
                tenantId: "default-wrong-usage",
                id: attestationKeyChain,
            }),
        ).toBe(0);

        // The folder plan names the reason.
        const folder = join(runtimeFolder, "config", "default-wrong-usage");
        const plan = await app
            .get(ConfigBundleService)
            .plan(
                "default-wrong-usage",
                app
                    .get(ConfigFolderBundleService)
                    .buildBundle("default-wrong-usage", folder),
                "upsert",
                `folder:${folder}`,
            );
        expect(plan.applicable).toBe(false);
        expect(plan.issues).toEqual([
            expect.objectContaining({
                code: "KEY_CHAIN_USAGE_MISMATCH",
                path: "/spec/access",
                resource: { kind: "KeyChainDefaults", id: "defaults" },
            }),
        ]);
    });

    it("skips detached key chain defaults at startup and resets them to the file", async () => {
        const ownership = app.get(ConfigOwnershipService);
        const folder = app.get(ConfigFolderBundleService);
        const tenantId = "default-detach";
        // Detach and remove the default, as the UI would.
        await ownership.detach(tenantId, "KeyChainDefaults", "defaults");
        await app
            .get(DataSource)
            .getRepository(TenantEntity)
            .update({ id: tenantId }, { defaultKeyChains: null as any });
        await ownership.recordApiMutation(
            tenantId,
            "KeyChainDefaults",
            "defaults",
            false,
        );

        await folder.applyTenantFolder(tenantId, "upsert");
        expect((await tenant(tenantId))?.defaultKeyChains ?? null).toBeNull();
        expect(warnings()).toContain(
            `[${tenantId}] Skipped KeyChainDefaults 'defaults' (RESOURCE_DETACHED)`,
        );

        const plan = await folder.planReattach(
            tenantId,
            "KeyChainDefaults",
            "defaults",
        );
        expect(plan.applicable, JSON.stringify(plan.issues)).toBe(true);
        expect(plan.items).toEqual([
            expect.objectContaining({
                kind: "KeyChainDefaults",
                action: "update",
            }),
        ]);
        await folder.reattach(
            tenantId,
            "KeyChainDefaults",
            "defaults",
            plan.planFingerprint!,
        );

        expect((await tenant(tenantId))?.defaultKeyChains).toEqual({
            access: accessKeyChain,
        });
        expect(
            await ownership.get(tenantId, "KeyChainDefaults", "defaults"),
        ).toMatchObject({ ownership: "file-managed" });
    });
});
