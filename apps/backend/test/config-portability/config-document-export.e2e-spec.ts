import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    normalizeDocument,
    resourceId,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    KeyChainEntity,
    KeyUsage,
} from "../../src/crypto/key/entities/key-chain.entity.js";
import { TrustList } from "../../src/issuer/trust-list/entities/trust-list.entity.js";
import { ConfigBundleService } from "../../src/platform/config-portability/config-bundle.service.js";
import { ConfigFolderBundleService } from "../../src/platform/config-portability/config-folder-bundle.service.js";
import { PresentationConfig } from "../../src/verifier/presentations/entities/presentation-config.entity.js";

/** A client with tenant:admin, added to each tenant folder before startup. */
const adminSecret = "admin-secret";
/** Client IDs are unique across tenants. */
const adminClientId = (tenant: string) => `${tenant}-document-export-admin`;
/** The secrets of the fixture files, which exports name as placeholders. */
const fixtureSecrets: Record<string, string> = {
    [adminClientId("demo")]: adminSecret,
    [adminClientId("haip")]: adminSecret,
    "test-client": "test-client-secret",
    "haip-test-client": "test-client-secret",
    "presentation-test": "presentation-test-secret",
    notification: "foo-bar",
};
const tenants = {
    demo: resolve(__dirname, "../../../../assets/config/demo"),
    haip: resolve(__dirname, "../fixtures/haip"),
};

/**
 * Every resource downloaded as a configuration document is a file the
 * startup import accepts as it is: a config folder made of the downloaded
 * files plans no change.
 */
describe("single-resource configuration documents", () => {
    let app: INestApplication;
    let runtimeFolder: string;
    let configRoot: string;
    const overridden = [
        "CONFIG_FOLDER",
        "CONFIG_IMPORT_MODE",
        "FOLDER",
    ] as const;
    const originalEnvironment = Object.fromEntries(
        overridden.map((key) => [key, process.env[key]]),
    );
    const placeholders = new Set<string>();

    /** A token of a client of the tenant; not getToken from ../utils.js (see e2e-utils). */
    async function token(clientId: string, secret: string): Promise<string> {
        const response = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: secret,
            })
            .expect(201);
        return `Bearer ${response.body.access_token}`;
    }

    /** A signing key chain of the demo tenant held in the database. */
    function signingKeyChain(): Promise<KeyChainEntity> {
        return app
            .get(DataSource)
            .getRepository(KeyChainEntity)
            .findOneByOrFail({
                tenantId: "demo",
                kmsProvider: "db",
                usage: KeyUsage.Sign,
            });
    }

    function download(auth: string, kind: string, id: string) {
        return request(app.getHttpServer())
            .get(
                `/config-bundles/resources/${kind}/${encodeURIComponent(id)}/document`,
            )
            .set("Authorization", auth);
    }

    beforeAll(async () => {
        runtimeFolder = mkdtempSync(join(tmpdir(), "eudiplo-document-export-"));
        configRoot = join(runtimeFolder, "config");
        for (const [tenant, source] of Object.entries(tenants)) {
            cpSync(source, join(configRoot, tenant), { recursive: true });
            writeFileSync(
                join(
                    configRoot,
                    tenant,
                    "clients",
                    "document-export-admin.json",
                ),
                JSON.stringify({
                    $schema: schemaUrl("Client"),
                    spec: {
                        clientId: adminClientId(tenant),
                        secret: adminSecret,
                        roles: ["tenant:admin"],
                    },
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
        for (const key of [...overridden, ...placeholders]) {
            const value = originalEnvironment[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it.each(Object.keys(tenants))(
        "re-imports every resource of %s unchanged from its downloaded document",
        async (tenant) => {
            const tenantRoot = join(configRoot, tenant);
            const folder = app.get(ConfigFolderBundleService);
            const resources = folder.buildBundle(tenant, tenantRoot).manifest
                .resources;
            expect(resources.length).toBeGreaterThan(5);
            const auth = await token(adminClientId(tenant), adminSecret);
            const downloaded = new Map<string, Record<string, unknown>>();

            for (const resource of resources) {
                const response = await download(
                    auth,
                    resource.kind,
                    resource.id,
                ).expect(200);
                const document = response.body;
                expect(
                    Object.keys(document).filter(
                        (key) => !["$schema", "metadata", "spec"].includes(key),
                    ),
                ).toEqual([]);
                expect(document.$schema).toBe(schemaUrl(resource.kind));
                expect(normalizeDocument(document).kind).toBe(resource.kind);
                expect(resourceId(document)).toBe(resource.id);
                // Secrets are placeholders; the test environment supplies them.
                for (const [, name] of JSON.stringify(document).matchAll(
                    /\$\{([A-Za-z0-9_]+)\}/g,
                )) {
                    placeholders.add(name);
                    const secret = fixtureSecrets[resource.id];
                    expect(secret, `fixture secret of ${name}`).toBeDefined();
                    process.env[name] = secret;
                }
                downloaded.set(resource.path, document);
            }

            // Only the downloaded files and the images they name remain.
            rmSync(tenantRoot, { recursive: true });
            cpSync(
                join(tenants[tenant as keyof typeof tenants], "images"),
                join(tenantRoot, "images"),
                { recursive: true },
            );
            for (const [path, document] of downloaded) {
                mkdirSync(dirname(join(tenantRoot, path)), { recursive: true });
                writeFileSync(
                    join(tenantRoot, path),
                    JSON.stringify(document, null, 2),
                );
            }

            const plan = await app
                .get(ConfigBundleService)
                .plan(
                    tenant,
                    folder.buildBundle(tenant, tenantRoot),
                    "upsert",
                    `folder:${tenantRoot}`,
                );
            expect(plan.issues).toEqual([]);
            expect(
                plan.items
                    .filter((item) => item.action !== "unchanged")
                    .map((item) => `${item.kind}/${item.id}: ${item.action}`),
            ).toEqual([]);
        },
    );

    it("keeps a plan current when a trust list is signed again", async () => {
        const service = app.get(ConfigBundleService);
        const bundle = await service.exportBundle("demo");
        const before = await service.plan("demo", bundle, "upsert");
        // A new signature of the list is no configuration change.
        await app
            .get(DataSource)
            .getRepository(TrustList)
            .update({ tenantId: "demo" }, { jwt: "eyJhbGciOiJub25lIn0.e30." });

        const after = await service.plan("demo", bundle, "upsert");
        expect(after.planFingerprint).toBe(before.planFingerprint);
    });

    it("exports the allowed origins of a presentation configuration", async () => {
        const repository = app
            .get(DataSource)
            .getRepository(PresentationConfig);
        const [withOrigins, without] = await repository.find({
            where: { tenantId: "demo" },
            order: { id: "ASC" },
            take: 2,
        });
        const auth = await token(adminClientId("demo"), adminSecret);
        await repository.update(
            { tenantId: "demo", id: withOrigins.id },
            { allowedOrigins: ["https://shop.example"] },
        );
        try {
            const exported = await download(
                auth,
                "PresentationConfig",
                withOrigins.id,
            ).expect(200);
            expect(exported.body.$schema).toBe(
                schemaUrl("PresentationConfig", 4),
            );
            expect(exported.body.spec.allowedOrigins).toEqual([
                "https://shop.example",
            ]);

            const plain = await download(
                auth,
                "PresentationConfig",
                without.id,
            ).expect(200);
            expect(plain.body.spec).not.toHaveProperty("allowedOrigins");
        } finally {
            await repository.update(
                { tenantId: "demo", id: withOrigins.id },
                { allowedOrigins: null },
            );
        }
    });

    it("keeps the private keys of a key chain held in the database", async () => {
        const keyChain = await signingKeyChain();
        const response = await download(
            await token(adminClientId("demo"), adminSecret),
            "KeyChain",
            keyChain.id,
        ).expect(200);

        expect(response.body.spec.keySource.type).toBe("private-jwk");
        expect(response.body.spec.keySource.jwk.d).toBeDefined();
    });

    it("needs tenant:admin for a key chain and a managing role for other kinds", async () => {
        const auth = await token("test-client", "test-client-secret");
        const keyChain = await signingKeyChain();

        await download(auth, "KeyChain", keyChain.id).expect(403);
        await download(auth, "KmsConfig", "kms").expect(403);
        const credential = await download(auth, "CredentialConfig", "pid")
            .expect(200)
            .then((response) => response.body);
        expect(credential.$schema).toBe(schemaUrl("CredentialConfig"));
    });

    it("answers unknown resources with 404 and unknown kinds with 400", async () => {
        const auth = await token(adminClientId("demo"), adminSecret);
        const encryption = await app
            .get(DataSource)
            .getRepository(KeyChainEntity)
            .findOneByOrFail({ tenantId: "demo", usage: KeyUsage.Encrypt });

        await download(auth, "CredentialConfig", "missing").expect(404);
        // Singletons have one fixed ID.
        await download(auth, "IssuanceConfig", "other").expect(404);
        await download(auth, "IssuanceConfig", "issuance").expect(200);
        // The encryption key chain is system-owned, not configuration.
        await download(auth, "KeyChain", encryption.id).expect(404);
        await download(auth, "Unknown", "x").expect(400);
    });
});
