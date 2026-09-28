import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { describeWithContainers } from "../container-runtime.js";
import { getToken } from "../utils.js";

const VAULT_DEV_ROOT_TOKEN = "test-root-token";

describeWithContainers("Key Chain — Vault KMS (e2e)", () => {
    let vaultContainer: StartedTestContainer;
    let app: INestApplication;
    let authToken: string;
    let tmpConfigDir: string;

    beforeAll(async () => {
        // 1. Start a Vault dev server in a container
        vaultContainer = await new GenericContainer("hashicorp/vault:1.19")
            .withExposedPorts(8200)
            .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: VAULT_DEV_ROOT_TOKEN })
            .withWaitStrategy(
                Wait.forHttp("/v1/sys/health", 8200).forStatusCode(200),
            )
            .start();

        const vaultUrl = `http://${vaultContainer.getHost()}:${vaultContainer.getMappedPort(8200)}`;

        // 2. Create a temporary config folder with kms.json pointing to the container
        tmpConfigDir = mkdtempSync(join(tmpdir(), "eudiplo-vault-test-"));
        const tenantDir = join(tmpConfigDir, "test-tenant");
        if (!existsSync(tenantDir)) {
            mkdirSync(tenantDir, { recursive: true });
        }

        writeFileSync(
            join(tmpConfigDir, "kms.json"),
            JSON.stringify({
                defaultProvider: "vault",
                providers: [
                    { id: "db", type: "db" },
                    {
                        id: "vault",
                        type: "vault",
                        vaultUrl,
                        vaultToken: VAULT_DEV_ROOT_TOKEN,
                    },
                ],
            }),
        );

        // 3. Boot the NestJS app with CONFIG_FOLDER pointing to our temp dir
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
        authToken = await getToken(app, clientId, clientSecret);
    }, 120_000); // container startup can be slow

    afterAll(async () => {
        await app?.close();
        await vaultContainer?.stop();
    });

    test("vault provider is available", async () => {
        const res = await request(app.getHttpServer())
            .get("/key-chain/providers")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const vault = res.body.providers.find((p: any) => p.name === "vault");
        expect(vault).toBeDefined();
        expect(vault.capabilities.canCreate).toBe(true);
    });

    test("create → get → delete (vault)", async () => {
        // Create key chain
        const createRes = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                type: KeyChainType.Standalone,
                usageType: "access",
                kmsProvider: "vault",
                description: "vault e2e test key chain",
            })
            .expect(201);

        const keyChainId = createRes.body.id;
        expect(keyChainId).toBeDefined();

        // Get by ID
        const getRes = await request(app.getHttpServer())
            .get(`/key-chain/${keyChainId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(getRes.body.id).toBe(keyChainId);
        expect(getRes.body.kmsProvider).toBe("vault");

        // List — key chain should be present
        const listRes = await request(app.getHttpServer())
            .get("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(
            listRes.body.find((k: any) => k.id === keyChainId),
        ).toBeDefined();

        // Delete
        await request(app.getHttpServer())
            .delete(`/key-chain/${keyChainId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(204);

        // Confirm deleted
        await request(app.getHttpServer())
            .get(`/key-chain/${keyChainId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(404);
    });

    test("vault mount is created automatically on first key chain", async () => {
        // Creating a key chain for a fresh tenant should auto-create the transit mount
        const res = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                type: KeyChainType.Standalone,
                usageType: "access",
                kmsProvider: "vault",
            })
            .expect(201);

        expect(res.body.id).toBeDefined();
    });
});
