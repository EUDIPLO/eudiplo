import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { ConfigOwnershipService } from "../../src/platform/config-portability/config-ownership.service.js";

/**
 * The demo tenant ships with `eudiplo demo` and `eudiplo init --demo-tenant`,
 * neither of which relaxes the outbound URL policy. The other suites run with
 * OUTBOUND_URL_ALLOW_HTTP and OUTBOUND_URL_ALLOW_PRIVATE_NETWORK enabled
 * (vitest.config.ts), so this suite turns both off again and checks that the
 * startup import applies the whole tenant.
 */
describe("demo tenant import under the default outbound URL policy", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    let demoFolder: string;
    const overridden = [
        "CONFIG_FOLDER",
        "CONFIG_IMPORT_MODE",
        "FOLDER",
        "OUTBOUND_URL_ALLOW_HTTP",
        "OUTBOUND_URL_ALLOW_PRIVATE_NETWORK",
    ] as const;
    const originalEnvironment = Object.fromEntries(
        overridden.map((key) => [key, process.env[key]]),
    );

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-demo-import-"));
        const configRoot = join(runtimeFolder, "config");
        mkdirSync(configRoot);
        demoFolder = join(configRoot, "demo");
        cpSync(
            resolve(__dirname, "../../../../assets/config/demo"),
            demoFolder,
            { recursive: true },
        );
        process.env.CONFIG_FOLDER = configRoot;
        process.env.CONFIG_IMPORT_MODE = "create";
        process.env.FOLDER = runtimeFolder;
        process.env.OUTBOUND_URL_ALLOW_HTTP = "false";
        process.env.OUTBOUND_URL_ALLOW_PRIVATE_NETWORK = "false";

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
        for (const key of overridden) {
            const value = originalEnvironment[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it("imports every resource of the demo folder", async () => {
        const bundle = app
            .get(ConfigFolderBundleService)
            .buildBundle("demo", demoFolder);
        const imported = (
            await app.get(ConfigOwnershipService).list("demo")
        ).map((entry) => `${entry.kind}/${entry.resourceId}`);

        expect(bundle.manifest.resources.length).toBeGreaterThan(0);
        expect(imported).toEqual(
            expect.arrayContaining(
                bundle.manifest.resources.map(
                    (resource) => `${resource.kind}/${resource.id}`,
                ),
            ),
        );
    });

    it("serves the issuer metadata of the demo tenant", async () => {
        await request(app.getHttpServer())
            .get("/.well-known/openid-credential-issuer/issuers/demo")
            .set("Accept", "application/json")
            .expect(200);
    });
});
