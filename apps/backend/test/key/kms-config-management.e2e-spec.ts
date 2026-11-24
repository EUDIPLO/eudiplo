import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KmsConfigService } from "../../src/crypto/key/kms/kms-config.service.js";
import { KmsProviderRegistry } from "../../src/crypto/key/kms/kms-provider.registry.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { documentBundle } from "../shared/config-bundle.js";
import { getTenantAdminToken, getToken } from "../utils.js";

function createTempConfigDir() {
    return mkdtempSync(join(tmpdir(), "eudiplo-kms-config-test-"));
}

describe("Key Chain — KMS configuration management (e2e)", () => {
    let app: INestApplication;
    /** Token of a tenant administrator, allowed to manage the KMS config. */
    let authToken: string;
    /** Token with only the issuance and presentation management roles. */
    let managerToken: string;
    let tmpConfigDir: string;

    const GLOBAL_SECRET = "global-vault-secret";
    const TENANT_SECRET = "tenant-vault-secret";
    const UNLISTED_SECRET = "unlisted-operator-secret";
    const LISTED_SECRET = "listed-tenant-kms-token";
    const TENANT_ID = "kms-config-admin";
    /** A file the operator lets tenant kms.json files name; it does not exist. */
    const LISTED_LIBRARY = "/usr/lib/e2e-listed-pkcs11.so";
    /** A global provider that allows only ES256 for new key chains. */
    const ES256_ONLY = "db-es256-only";

    /** The stored tenant file, as written by the API. */
    const storedTenantConfig = () =>
        JSON.parse(
            readFileSync(join(tmpConfigDir, TENANT_ID, "kms.json"), "utf8"),
        );

    beforeAll(async () => {
        tmpConfigDir = createTempConfigDir();
        // A global provider whose credential comes from the environment.
        process.env.E2E_GLOBAL_VAULT_TOKEN = GLOBAL_SECRET;
        // An operator variable: only the listed one resolves in tenant files.
        process.env.E2E_UNLISTED_SECRET = UNLISTED_SECRET;
        process.env.E2E_TENANT_KMS_TOKEN = LISTED_SECRET;
        writeFileSync(
            join(tmpConfigDir, "kms.json"),
            JSON.stringify({
                providers: [
                    { id: "db", type: "db" },
                    { id: ES256_ONLY, type: "db", algorithms: ["ES256"] },
                    {
                        id: "global-vault",
                        type: "vault",
                        vaultUrl: "http://127.0.0.1:9",
                        vaultToken: "${E2E_GLOBAL_VAULT_TOKEN}",
                    },
                ],
            }),
        );

        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({
                    isGlobal: true,
                    load: [
                        () => ({
                            CONFIG_FOLDER: tmpConfigDir,
                            KMS_TENANT_VARIABLES: "E2E_TENANT_KMS_TOKEN",
                            KMS_TENANT_FILES: LISTED_LIBRARY,
                        }),
                    ],
                }),
                AppModule,
            ],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        const clientSecret =
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
        managerToken = await getToken(app, clientId, clientSecret);
        authToken = await getTenantAdminToken(
            app,
            clientId,
            clientSecret,
            TENANT_ID,
        );
    });

    test("requires tenant:admin or tenants:manage for the provider config", async () => {
        const server = app.getHttpServer();
        await request(server)
            .get("/key-chain/providers/config")
            .set("Authorization", `Bearer ${managerToken}`)
            .expect(403);
        await request(server)
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${managerToken}`)
            .send({ providers: [{ id: "db", type: "db" }] })
            .expect(403);
        await request(server)
            .delete("/key-chain/providers/config")
            .set("Authorization", `Bearer ${managerToken}`)
            .expect(403);
        // Listing providers and their health stays available.
        await request(server)
            .get("/key-chain/providers/health")
            .set("Authorization", `Bearer ${managerToken}`)
            .expect(200);

        await request(server)
            .get("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
    });

    afterAll(async () => {
        await app?.close();
        rmSync(tmpConfigDir, { recursive: true, force: true });
        delete process.env.E2E_GLOBAL_VAULT_TOKEN;
        delete process.env.E2E_UNLISTED_SECRET;
        delete process.env.E2E_TENANT_KMS_TOKEN;
    });

    test("accepts and returns a valid tenant KMS configuration", async () => {
        const body = {
            defaultProvider: "vault",
            providers: [
                { id: "db", type: "db" },
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "https://vault.example.com",
                    vaultToken: TENANT_SECRET,
                },
            ],
        };
        const redacted = {
            ...body,
            providers: [
                body.providers[0],
                { ...body.providers[1], vaultToken: "<redacted>" },
            ],
        };

        const res = await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send(body)
            .expect(200);

        expect(res.body.tenantConfig).toEqual(redacted);
        expect(res.body.effectiveConfig.defaultProvider).toBe("vault");
        expect(res.body.effectiveConfig.providers).toEqual(
            expect.arrayContaining(redacted.providers),
        );
        expect(storedTenantConfig().providers[1].vaultToken).toBe(
            TENANT_SECRET,
        );
    });

    test("never returns credentials of the tenant or the global configuration", async () => {
        const res = await request(app.getHttpServer())
            .get("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const json = JSON.stringify(res.body);
        expect(json).not.toContain(TENANT_SECRET);
        expect(json).not.toContain(GLOBAL_SECRET);
        expect(json).not.toContain("E2E_GLOBAL_VAULT_TOKEN");
        expect(
            res.body.effectiveConfig.providers.find(
                (provider: { id: string }) => provider.id === "global-vault",
            ),
        ).toEqual({
            id: "global-vault",
            type: "vault",
            vaultUrl: "http://127.0.0.1:9",
            vaultToken: "<redacted>",
        });
    });

    test("keeps a stored credential that is sent back as <redacted>", async () => {
        const current = await request(app.getHttpServer())
            .get("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const update = current.body.tenantConfig;
        update.providers[1].description = "renamed";

        await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send(update)
            .expect(200);

        expect(storedTenantConfig().providers[1]).toMatchObject({
            description: "renamed",
            vaultToken: TENANT_SECRET,
        });
    });

    test("rejects <redacted> when the provider's URL changes", async () => {
        const current = await request(app.getHttpServer())
            .get("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const update = current.body.tenantConfig;
        const storedUrl = storedTenantConfig().providers[1].vaultUrl;
        update.providers[1].vaultUrl = "https://attacker.example.com";

        const res = await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send(update)
            .expect(400);

        expect(res.body.message).toContain("vaultUrl changes");
        expect(storedTenantConfig().providers[1]).toMatchObject({
            vaultUrl: storedUrl,
            vaultToken: TENANT_SECRET,
        });
    });

    test("replaces a stored credential that is sent with a new value", async () => {
        const res = await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                defaultProvider: "vault",
                providers: [
                    { id: "db", type: "db" },
                    {
                        id: "vault",
                        type: "vault",
                        vaultUrl: "https://vault.example.com",
                        vaultToken: "new-vault-secret",
                    },
                ],
            })
            .expect(200);

        expect(res.body.tenantConfig.providers[1].vaultToken).toBe(
            "<redacted>",
        );
        expect(JSON.stringify(res.body)).not.toContain("new-vault-secret");
        expect(storedTenantConfig().providers[1].vaultToken).toBe(
            "new-vault-secret",
        );
    });

    test.each([
        ["a credential", { vaultToken: "${MASTER_SECRET}" }],
        ["a part of a credential", { vaultToken: "x${MASTER_SECRET}" }],
        ["an operator variable", { vaultToken: "${E2E_UNLISTED_SECRET}" }],
        ["a listed variable", { vaultToken: "${E2E_TENANT_KMS_TOKEN}" }],
        ["a description", { description: "${MASTER_SECRET}" }],
        ["the default form", { description: "${E2E_TENANT_KMS_TOKEN:x}" }],
    ])("refuses a placeholder sent as %s", async (_, change) => {
        const stored = storedTenantConfig();
        const update = {
            defaultProvider: "vault",
            providers: [
                { id: "db", type: "db" },
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "https://vault.example.com",
                    vaultToken: "<redacted>",
                    ...change,
                },
            ],
        };

        const res = await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send(update)
            .expect(400);
        expect(res.body.message).toContain("placeholder");

        const bundle = documentBundle(
            TENANT_ID,
            "KmsConfig",
            "kms",
            "kms.json",
            {
                ...update,
                providers: [
                    update.providers[0],
                    {
                        ...update.providers[1],
                        vaultToken: "a-token",
                        ...change,
                    },
                ],
            },
        );
        const plan = await request(app.getHttpServer())
            .post("/config-bundles/plan?mode=upsert")
            .set("Authorization", `Bearer ${authToken}`)
            .send(bundle)
            .expect(201);
        expect(plan.body.applicable).toBe(false);
        expect(plan.body.items[0].issues).toContainEqual(
            expect.objectContaining({ code: "KMS_PLACEHOLDER_REFUSED" }),
        );
        await request(app.getHttpServer())
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${plan.body.planFingerprint}`,
            )
            .set("Authorization", `Bearer ${authToken}`)
            .send(bundle)
            .expect((response) => {
                expect(response.status).toBeGreaterThanOrEqual(400);
                expect(response.status).toBeLessThan(500);
            });

        expect(storedTenantConfig()).toEqual(stored);
    });

    test("rejects <redacted> for a credential that is not stored", async () => {
        const res = await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                providers: [
                    { id: "db", type: "db" },
                    {
                        id: "global-vault",
                        type: "vault",
                        vaultUrl: "http://127.0.0.1:9",
                        vaultToken: "<redacted>",
                    },
                ],
            })
            .expect(400);

        expect(res.body.message).toContain("global-vault");
        expect(storedTenantConfig().providers[1].id).toBe("vault");
    });

    test("a provider limited to ES256 refuses ES512 and reports its algorithms", async () => {
        const server = app.getHttpServer();
        const providers = await request(server)
            .get("/key-chain/providers")
            .set("Authorization", `Bearer ${managerToken}`)
            .expect(200);
        const byName = (name: string) =>
            providers.body.providers.find(
                (provider: { name: string }) => provider.name === name,
            );
        expect(byName(ES256_ONLY).capabilities).toMatchObject({
            supportedAlgs: ["ES256"],
            defaultAlg: "ES256",
        });
        expect(byName("db").capabilities.supportedAlgs).toEqual([
            "ES256",
            "ES384",
            "ES512",
        ]);

        const refused = await request(server)
            .post("/key-chain")
            .set("Authorization", `Bearer ${managerToken}`)
            .send({
                type: "standalone",
                usageType: "attestation",
                kmsProvider: ES256_ONLY,
                alg: "ES512",
            })
            .expect(400);
        expect(refused.body.message).toContain(ES256_ONLY);

        const created = await request(server)
            .post("/key-chain")
            .set("Authorization", `Bearer ${managerToken}`)
            .send({
                type: "standalone",
                usageType: "attestation",
                kmsProvider: ES256_ONLY,
            })
            .expect(201);
        const keyChain = await request(server)
            .get(`/key-chain/${created.body.id}`)
            .set("Authorization", `Bearer ${managerToken}`)
            .expect(200);
        expect(keyChain.body.alg).toBe("ES256");
        await request(server)
            .delete(`/key-chain/${created.body.id}`)
            .set("Authorization", `Bearer ${managerToken}`)
            .expect(204);
    });

    test("rejects a defaultAlgorithm outside the provider's algorithms", async () => {
        const res = await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                providers: [
                    {
                        id: "db",
                        type: "db",
                        algorithms: ["ES256"],
                        defaultAlgorithm: "ES384",
                    },
                ],
            })
            .expect(400);
        expect(JSON.stringify(res.body)).toContain(
            "defaultAlgorithm 'ES384' is not in algorithms (ES256)",
        );
    });

    test("rejects invalid KMS configurations", async () => {
        await request(app.getHttpServer())
            .put("/key-chain/providers/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                defaultProvider: "missing",
                providers: [
                    { id: "db", type: "db" },
                    {
                        id: "db",
                        type: "vault",
                        vaultUrl: "https://vault.example.com",
                        vaultToken: TENANT_SECRET,
                    },
                ],
            })
            .expect(400);
    });

    test("reads a tenant kms.json written as a configuration document", async () => {
        const server = app.getHttpServer();
        const tenantFile = join(tmpConfigDir, TENANT_ID, "kms.json");
        const spec = {
            defaultProvider: "tenant-db",
            providers: [{ id: "tenant-db", type: "db" }],
        };
        try {
            writeFileSync(
                tenantFile,
                JSON.stringify({
                    $schema:
                        "https://eudiplo.dev/schemas/v1/KmsConfigFile.schema.json",
                    spec,
                }),
            );
            app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);

            const res = await request(server)
                .get("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            expect(res.body.tenantConfig).toEqual(spec);
            expect(res.body.effectiveConfig.defaultProvider).toBe("tenant-db");

            writeFileSync(
                tenantFile,
                JSON.stringify({
                    $schema:
                        "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json",
                    spec: { name: "demo" },
                }),
            );
            const refused = await request(server)
                .get("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(400);
            expect(JSON.stringify(refused.body)).toContain(
                "expected a KmsConfig document",
            );
        } finally {
            await request(server)
                .delete("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(204);
        }
    });

    test("answers 400 for a tenant kms.json that is not JSON or no KMS configuration and lets the tenant replace or remove it", async () => {
        const server = app.getHttpServer();
        const tenantFile = join(tmpConfigDir, TENANT_ID, "kms.json");
        const auth = { Authorization: `Bearer ${authToken}` };
        const next = { providers: [{ id: "tenant-db", type: "db" }] };
        const bundle = documentBundle(
            TENANT_ID,
            "KmsConfig",
            "kms",
            "kms.json",
            next,
        );
        const requests = () => ({
            get: request(server).get("/key-chain/providers/config").set(auth),
            exported: request(server).get("/config-bundles/export").set(auth),
            plan: request(server)
                .post("/config-bundles/plan?mode=upsert")
                .set(auth)
                .send(bundle),
            // An import needs the fingerprint of such a plan.
            keyChain: request(server)
                .post("/key-chain")
                .set(auth)
                .send({ type: "standalone", usageType: "attestation" }),
        });
        const remove = () =>
            request(server).delete("/key-chain/providers/config").set(auth);
        const put = (config: object) =>
            request(server)
                .put("/key-chain/providers/config")
                .set(auth)
                .send(config);
        const vault = (vaultToken: string) => ({
            providers: [
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "https://vault.example",
                    vaultToken,
                },
            ],
        });
        // The parser quotes this text in its message.
        const notJson = "hvs.stored-secret";
        const wrongKind = JSON.stringify({
            $schema:
                "https://eudiplo.dev/schemas/v1/TenantConfigFile.schema.json",
            spec: { name: "demo" },
        });
        let failure: unknown;
        try {
            mkdirSync(join(tmpConfigDir, TENANT_ID), { recursive: true });
            for (const [stored, reason] of [
                [
                    notJson,
                    `tenant '${TENANT_ID}' kms.json: the file is not valid JSON`,
                ],
                [wrongKind, "expected a KmsConfig document"],
            ]) {
                writeFileSync(tenantFile, stored);
                app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
                for (const [name, pending] of Object.entries(requests())) {
                    const res = await pending;
                    const body = JSON.stringify(res.body);
                    expect(res.status, `${name}: ${body}`).toBe(400);
                    expect(body, name).toContain(reason);
                    expect(body, name).not.toContain("stored-secret");
                }
                // Nothing of such a file is kept.
                for (const [kept, refusal] of [
                    ["<redacted>", "stores no value"],
                    ["${TENANT_TOKEN}", "does not accept placeholders"],
                ]) {
                    const res = await put(vault(kept)).expect(400);
                    expect(res.body.message).toContain(refusal);
                    expect(JSON.stringify(res.body)).not.toContain(
                        "stored-secret",
                    );
                }
                expect(readFileSync(tenantFile, "utf8")).toBe(stored);
                await remove().expect(204);
                expect(existsSync(tenantFile)).toBe(false);

                writeFileSync(tenantFile, stored);
                app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
                const replaced = await put(next).expect(200);
                expect(replaced.body.tenantConfig).toEqual(next);
                expect(JSON.parse(readFileSync(tenantFile, "utf8"))).toEqual(
                    next,
                );
                const read = await requests().get.expect(200);
                expect(read.body.tenantConfig).toEqual(next);
                // The tenant's providers are loaded from the new file.
                const health = await request(server)
                    .get("/key-chain/providers/health")
                    .set(auth)
                    .expect(200);
                expect(JSON.stringify(health.body)).toContain("tenant-db");
            }
        } catch (error) {
            failure = error;
        }
        await remove();
        if (failure) throw failure;
        await requests().get.expect(200);
    });

    describe("placeholders in a stored tenant kms.json", () => {
        let kms: Server;
        let kmsUrl: string;
        /** Authorization headers the tenant's HTTP KMS received. */
        let received: (string | undefined)[];
        const tenantFile = () => join(tmpConfigDir, TENANT_ID, "kms.json");

        /** Store the file as an operator, or an earlier API version, did. */
        const storeTenantFile = (token: string) => {
            writeFileSync(
                tenantFile(),
                JSON.stringify({
                    defaultProvider: "remote",
                    providers: [
                        {
                            id: "remote",
                            type: "http",
                            baseUrl: kmsUrl,
                            auth: { type: "bearer", token },
                        },
                    ],
                }),
            );
            app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
            app.get(KmsProviderRegistry).invalidateTenant(TENANT_ID);
            received = [];
        };
        const health = () =>
            request(app.getHttpServer())
                .get("/key-chain/providers/health")
                .set("Authorization", `Bearer ${authToken}`);

        beforeAll(async () => {
            kms = createServer((req, res) => {
                received.push(req.headers.authorization);
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ status: "ok" }));
            });
            await new Promise<void>((resolve) =>
                kms.listen(0, "127.0.0.1", resolve),
            );
            kmsUrl = `http://127.0.0.1:${(kms.address() as AddressInfo).port}`;
        });

        afterAll(async () => {
            await new Promise((resolve) => kms.close(resolve));
            rmSync(tenantFile(), { force: true });
            app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
            app.get(KmsProviderRegistry).invalidateTenant(TENANT_ID);
        });

        test("sends a variable listed in KMS_TENANT_VARIABLES", async () => {
            storeTenantFile("${E2E_TENANT_KMS_TOKEN}");

            await health().expect(200);

            expect(received).toContain(`Bearer ${LISTED_SECRET}`);
        });

        test("the API refuses placeholders in provider ids and returns no value", async () => {
            rmSync(tenantFile(), { force: true });
            app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
            const configService = app.get(ConfigService);
            const secrets = [
                configService.getOrThrow<string>("AUTH_CLIENT_SECRET"),
                configService.getOrThrow<string>("MASTER_SECRET"),
                LISTED_SECRET,
            ];

            const response = await request(app.getHttpServer())
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    providers: [
                        { id: "db", type: "db" },
                        { id: "${AUTH_CLIENT_SECRET}", type: "db" },
                        { id: "${MASTER_SECRET}", type: "db" },
                        { id: "${E2E_TENANT_KMS_TOKEN}", type: "db" },
                    ],
                })
                .expect(400);

            for (const secret of secrets) {
                expect(JSON.stringify(response.body)).not.toContain(secret);
            }
            expect(existsSync(tenantFile())).toBe(false);
        });

        test.each([
            [
                "a provider id",
                {
                    providers: [{ id: "${E2E_TENANT_KMS_TOKEN}", type: "db" }],
                },
            ],
            [
                "defaultProvider",
                {
                    defaultProvider: "${E2E_TENANT_KMS_TOKEN}",
                    providers: [{ id: "own", type: "db" }],
                },
            ],
        ])(
            "a stored file with a listed variable in %s is not loaded and shows no value",
            async (_, config) => {
                writeFileSync(tenantFile(), JSON.stringify(config));
                app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
                app.get(KmsProviderRegistry).invalidateTenant(TENANT_ID);

                const response = await request(app.getHttpServer())
                    .get("/key-chain/providers/config")
                    .set("Authorization", `Bearer ${authToken}`)
                    .expect(400);

                // The reason differs: the schema already refuses a defaultProvider
                // that is no provider of the file.
                expect(response.body.message).toBeDefined();
                expect(JSON.stringify(response.body)).not.toContain(
                    LISTED_SECRET,
                );
            },
        );

        test("shows a tenant provider with its stored placeholders", async () => {
            writeFileSync(
                tenantFile(),
                JSON.stringify({
                    providers: [
                        {
                            id: "remote",
                            type: "http",
                            description: "${E2E_TENANT_KMS_TOKEN}",
                            baseUrl: kmsUrl,
                            auth: {
                                type: "bearer",
                                token: "${E2E_TENANT_KMS_TOKEN}",
                            },
                        },
                    ],
                }),
            );
            app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
            app.get(KmsProviderRegistry).invalidateTenant(TENANT_ID);

            const response = await request(app.getHttpServer())
                .get("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

            expect(JSON.stringify(response.body)).not.toContain(LISTED_SECRET);
            expect(
                response.body.effectiveConfig.providers.find(
                    (provider: { id: string }) => provider.id === "remote",
                ),
            ).toMatchObject({
                description: "${E2E_TENANT_KMS_TOKEN}",
                auth: { token: "${E2E_TENANT_KMS_TOKEN}" },
            });
        });

        test("keeps a stored placeholder that is sent back, for the same address only", async () => {
            storeTenantFile("${E2E_TENANT_KMS_TOKEN}");
            const stored = readFileSync(tenantFile(), "utf8");
            const server = app.getHttpServer();
            const current = await request(server)
                .get("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            const update = current.body.tenantConfig;
            expect(update.providers[0].auth.token).toBe(
                "${E2E_TENANT_KMS_TOKEN}",
            );

            await request(server)
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    ...update,
                    providers: [
                        {
                            ...update.providers[0],
                            baseUrl: "https://attacker.example.com",
                        },
                    ],
                })
                .expect(400);
            expect(readFileSync(tenantFile(), "utf8")).toBe(stored);

            await request(server)
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send(update)
                .expect(200);
            expect(storedTenantConfig()).toEqual(JSON.parse(stored));

            // A stored placeholder the tenant could not load is not kept.
            storeTenantFile("${E2E_UNLISTED_SECRET}");
            const refused = await request(server)
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send(storedTenantConfig())
                .expect(400);
            expect(refused.body.message).toContain("E2E_UNLISTED_SECRET");
        });

        test("the reattach plan resolves only what the tenant kms.json may use", async () => {
            const plan = () =>
                request(app.getHttpServer())
                    .post(
                        "/config-bundles/resources/KmsConfig/kms/reattach/plan",
                    )
                    .set("Authorization", `Bearer ${authToken}`);
            const withDescription = (description: string) => {
                const file = storedTenantConfig();
                file.providers[0].description = description;
                writeFileSync(tenantFile(), JSON.stringify(file));
            };

            storeTenantFile("${E2E_TENANT_KMS_TOKEN}");
            const listed = await plan();
            expect(listed.status).toBeLessThan(300);
            expect(JSON.stringify(listed.body)).not.toContain(
                "KMS_PLACEHOLDER_REFUSED",
            );
            expect(JSON.stringify(listed.body)).not.toContain(LISTED_SECRET);

            // A listed variable in a setting that is no credential: the plan
            // shows the placeholder, and applying it keeps the file as it is.
            withDescription("${E2E_TENANT_KMS_TOKEN}");
            const stored = readFileSync(tenantFile(), "utf8");
            const kept = await plan();
            expect(kept.status).toBeLessThan(300);
            expect(JSON.stringify(kept.body)).not.toContain(LISTED_SECRET);
            expect(kept.body.applicable).toBe(true);
            const applied = await request(app.getHttpServer())
                .post("/config-bundles/resources/KmsConfig/kms/reattach")
                .query({ planFingerprint: kept.body.planFingerprint })
                .set("Authorization", `Bearer ${authToken}`);
            expect(`${applied.status} ${JSON.stringify(applied.body)}`).toMatch(
                /^2\d\d /,
            );
            expect(JSON.stringify(applied.body)).not.toContain(LISTED_SECRET);
            expect(readFileSync(tenantFile(), "utf8")).not.toContain(
                LISTED_SECRET,
            );
            expect(storedTenantConfig()).toEqual(JSON.parse(stored));
            // The reattached resource belongs to the folder; the tests that
            // follow change it through the API again.
            await request(app.getHttpServer())
                .post("/config-bundles/resources/KmsConfig/kms/detach")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(201);

            // An identifier, bare and as a document.
            for (const file of [
                { providers: [{ id: "${E2E_TENANT_KMS_TOKEN}", type: "db" }] },
                {
                    $schema:
                        "https://eudiplo.dev/schemas/v1/KmsConfigFile.schema.json",
                    spec: {
                        providers: [
                            { id: "${E2E_TENANT_KMS_TOKEN}", type: "db" },
                        ],
                    },
                },
            ]) {
                writeFileSync(tenantFile(), JSON.stringify(file));
                const refused = await plan();
                expect(refused.status).toBeGreaterThanOrEqual(400);
                expect(refused.status).toBeLessThan(500);
                const body = JSON.stringify(refused.body);
                expect(body).toContain("identifiers of a tenant kms.json");
                expect(body).not.toContain(LISTED_SECRET);
            }

            for (const [description, reason] of [
                ["${E2E_UNLISTED_SECRET}", "E2E_UNLISTED_SECRET"],
                ["${MASTER_SECRET}", "MASTER_SECRET"],
                ["${E2E_TENANT_KMS_TOKEN:x}", "${VAR:default}"],
            ]) {
                storeTenantFile("a-token");
                withDescription(description);
                const refused = await plan();
                expect(refused.status).toBeGreaterThanOrEqual(400);
                expect(refused.status).toBeLessThan(500);
                const body = JSON.stringify(refused.body);
                expect(body).toContain(reason);
                expect(body).not.toContain(UNLISTED_SECRET);
                expect(body).not.toContain(LISTED_SECRET);
                expect(body).not.toContain(
                    app.get(ConfigService).getOrThrow<string>("MASTER_SECRET"),
                );
            }
        });

        test("the API refuses an identifier placeholder the stored file holds", async () => {
            const spec = {
                providers: [{ id: "${E2E_TENANT_KMS_TOKEN}", type: "db" }],
            };
            writeFileSync(tenantFile(), JSON.stringify(spec));
            app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
            app.get(KmsProviderRegistry).invalidateTenant(TENANT_ID);
            const stored = readFileSync(tenantFile(), "utf8");

            const put = await request(app.getHttpServer())
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send(spec)
                .expect(400);
            expect(JSON.stringify(put.body)).not.toContain(LISTED_SECRET);
            expect(readFileSync(tenantFile(), "utf8")).toBe(stored);

            const plan = await request(app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${authToken}`)
                .send(
                    documentBundle(
                        TENANT_ID,
                        "KmsConfig",
                        "kms",
                        "kms.json",
                        spec,
                    ),
                )
                .expect(201);
            expect(plan.body.applicable).toBe(false);
            expect(plan.body.items[0].issues).toContainEqual(
                expect.objectContaining({ code: "KMS_PLACEHOLDER_REFUSED" }),
            );
            expect(JSON.stringify(plan.body)).not.toContain(LISTED_SECRET);
        });

        test("a bundle plan reports a kept placeholder the tenant cannot load", async () => {
            storeTenantFile("${E2E_UNLISTED_SECRET}");
            const spec = storedTenantConfig();
            spec.providers[0].description = "changed";
            const plan = await request(app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${authToken}`)
                .send(
                    documentBundle(
                        TENANT_ID,
                        "KmsConfig",
                        "kms",
                        "kms.json",
                        spec,
                    ),
                )
                .expect(201);
            expect(plan.body.applicable).toBe(false);
            expect(plan.body.items[0].issues).toContainEqual(
                expect.objectContaining({
                    code: "KMS_PLACEHOLDER_REFUSED",
                    message: expect.stringContaining("E2E_UNLISTED_SECRET"),
                }),
            );
        });

        test.each([
            ["a setting of EUDIPLO", "${MASTER_SECRET}", "MASTER_SECRET"],
            [
                "a setting of EUDIPLO inside a value",
                "x${MASTER_SECRET}",
                "MASTER_SECRET",
            ],
            [
                "a variable the operator did not list",
                "${E2E_UNLISTED_SECRET}",
                "E2E_UNLISTED_SECRET",
            ],
        ])("never sends %s", async (_, token, variable) => {
            const masterSecret = app
                .get(ConfigService)
                .getOrThrow<string>("MASTER_SECRET");
            storeTenantFile(token);

            const res = await health().expect(400);

            expect(res.body.message).toContain(variable);
            expect(JSON.stringify(res.body)).not.toContain(masterSecret);
            expect(JSON.stringify(res.body)).not.toContain(UNLISTED_SECRET);
            expect(received).toEqual([]);
            // The tenant administrator can still replace the file.
            await request(app.getHttpServer())
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ providers: [{ id: "db", type: "db" }] })
                .expect(200);
            await health().expect(200);
        });
    });

    describe("settings only the operator gives a tenant kms.json", () => {
        const tenantFile = () => join(tmpConfigDir, TENANT_ID, "kms.json");
        const pkcs11 = (library: string) => ({
            id: "hsm",
            type: "pkcs11",
            library,
            slot: 0,
            pin: "1234",
        });
        const refresh = () => {
            app.get(KmsConfigService).invalidateTenantCache(TENANT_ID);
            app.get(KmsProviderRegistry).invalidateTenant(TENANT_ID);
        };
        /** Store the file as an operator, or an earlier API version, did. */
        const storeTenantFile = (provider: Record<string, unknown>) => {
            mkdirSync(join(tmpConfigDir, TENANT_ID), { recursive: true });
            writeFileSync(
                tenantFile(),
                JSON.stringify({ providers: [provider] }),
            );
            refresh();
        };
        const put = (provider: Record<string, unknown>) =>
            request(app.getHttpServer())
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ providers: [{ id: "db", type: "db" }, provider] });
        const health = () =>
            request(app.getHttpServer())
                .get("/key-chain/providers/health")
                .set("Authorization", `Bearer ${authToken}`);

        beforeEach(() => {
            rmSync(tenantFile(), { force: true });
            refresh();
        });
        afterAll(() => {
            rmSync(tenantFile(), { force: true });
            refresh();
        });

        test.each([
            ["a PKCS#11 library", pkcs11("/app/config/uploads/3f1c2b7e")],
            // Listed files are the operator's to hand out, tenant by tenant.
            ["a listed PKCS#11 library", pkcs11(LISTED_LIBRARY)],
            [
                "mTLS files",
                {
                    id: "signer",
                    type: "http",
                    baseUrl: "https://signer.example.com",
                    auth: {
                        type: "mtls",
                        certFile: "/etc/certs/eudiplo.crt",
                        keyFile: "/dev/zero",
                    },
                },
            ],
        ])("the API does not store %s", async (_, provider) => {
            const res = await put(provider).expect(400);

            expect(res.body.message).toContain(
                "names a file of the backend's host",
            );
            expect(existsSync(tenantFile())).toBe(false);
            const plan = await request(app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${authToken}`)
                .send(
                    documentBundle(TENANT_ID, "KmsConfig", "kms", "kms.json", {
                        providers: [provider],
                    }),
                )
                .expect(201);
            expect(plan.body.applicable).toBe(false);
            expect(plan.body.items[0].issues).toContainEqual(
                expect.objectContaining({ code: "KMS_SETTING_REFUSED" }),
            );
        });

        test("the API does not store an aws-kms provider without credentials", async () => {
            const aws = { id: "aws", type: "aws-kms", region: "eu-central-1" };

            const res = await put(aws).expect(400);

            expect(res.body.message).toContain(
                "needs accessKeyId and secretAccessKey",
            );
            expect(existsSync(tenantFile())).toBe(false);
            const plan = await request(app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${authToken}`)
                .send(
                    documentBundle(TENANT_ID, "KmsConfig", "kms", "kms.json", {
                        providers: [aws],
                    }),
                )
                .expect(201);
            expect(plan.body.applicable).toBe(false);
            expect(plan.body.items[0].issues).toContainEqual(
                expect.objectContaining({ code: "KMS_SETTING_REFUSED" }),
            );
            await put({
                ...aws,
                accessKeyId: "AKIAE2EEXAMPLE",
                secretAccessKey: "e2e-secret-access-key",
            }).expect(200);
        });

        test("the API does not store a path that leaves the provider's baseUrl", async () => {
            const provider = {
                id: "signer",
                type: "http",
                baseUrl: "https://signer.example.com",
                auth: { type: "bearer", token: "e2e-token" },
                keysPath: "@attacker.example/keys",
            };
            const res = await put(provider).expect(400);

            expect(res.body.message).toContain(
                "keysPath must be a path on the server of baseUrl",
            );
            expect(existsSync(tenantFile())).toBe(false);
            const plan = await request(app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${authToken}`)
                .send(
                    documentBundle(TENANT_ID, "KmsConfig", "kms", "kms.json", {
                        providers: [provider],
                    }),
                )
                .expect(201);
            expect(plan.body.applicable).toBe(false);
            expect(plan.body.items[0].issues).toContainEqual(
                expect.objectContaining({ code: "KMS_SETTING_REFUSED" }),
            );
        });

        test("a stored file loads a listed library and keeps it through the API", async () => {
            storeTenantFile(pkcs11(LISTED_LIBRARY));

            const res = await health().expect(200);
            // The library does not exist: the provider is loaded and fails.
            expect(res.body).toContainEqual(
                expect.objectContaining({ providerId: "hsm", ok: false }),
            );
            await put({ ...pkcs11(LISTED_LIBRARY), pin: "<redacted>" }).expect(
                200,
            );
        });

        test.each([
            ["an unlisted library", pkcs11("/app/config/uploads/3f1c2b7e")],
            [
                "an aws-kms provider without credentials",
                { id: "aws", type: "aws-kms", region: "eu-central-1" },
            ],
        ])("a stored file with %s is not loaded", async (_, provider) => {
            storeTenantFile(provider);

            await health().expect(400);
            // Sent back unchanged, it is refused for the same reason.
            await request(app.getHttpServer())
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ providers: [{ ...provider, pin: undefined }] })
                .expect(400);

            // The tenant administrator can still replace the file.
            await request(app.getHttpServer())
                .put("/key-chain/providers/config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ providers: [{ id: "db", type: "db" }] })
                .expect(200);
            await health().expect(200);
        });
    });
});
