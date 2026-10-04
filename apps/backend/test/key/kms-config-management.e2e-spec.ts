import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
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
    const TENANT_ID = "kms-config-admin";

    /** The stored tenant file, as written by the API. */
    const storedTenantConfig = () =>
        JSON.parse(
            readFileSync(join(tmpConfigDir, TENANT_ID, "kms.json"), "utf8"),
        );

    beforeAll(async () => {
        tmpConfigDir = createTempConfigDir();
        // A global provider whose credential comes from the environment.
        process.env.E2E_GLOBAL_VAULT_TOKEN = GLOBAL_SECRET;
        process.env.E2E_NEW_VAULT_TOKEN = "new-vault-secret";
        writeFileSync(
            join(tmpConfigDir, "kms.json"),
            JSON.stringify({
                providers: [
                    { id: "db", type: "db" },
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
                    load: [() => ({ CONFIG_FOLDER: tmpConfigDir })],
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
        delete process.env.E2E_NEW_VAULT_TOKEN;
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
                        vaultToken: "${E2E_NEW_VAULT_TOKEN}",
                    },
                ],
            })
            .expect(200);

        // A placeholder names the secret without containing it.
        expect(res.body.tenantConfig.providers[1].vaultToken).toBe(
            "${E2E_NEW_VAULT_TOKEN}",
        );
        expect(JSON.stringify(res.body)).not.toContain("new-vault-secret");
        expect(storedTenantConfig().providers[1].vaultToken).toBe(
            "${E2E_NEW_VAULT_TOKEN}",
        );
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
});
