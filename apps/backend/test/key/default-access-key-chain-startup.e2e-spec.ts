import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";

// Kept apart from test/utils.ts: importing it before the environment is set
// turns the startup import off.

const fixtures = resolve(__dirname, "../fixtures/haip");
const accessKeyChain = "2f71c235-87e2-43c9-b572-739a3164ce95";
const attestationKeyChain = "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad";

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
});
