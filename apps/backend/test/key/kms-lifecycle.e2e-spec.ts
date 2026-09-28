import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getToken } from "../utils.js";

describe("Key Chain — KMS provider lifecycle (e2e)", () => {
    let app: INestApplication;
    let authToken: string;
    let availableProviders: {
        name: string;
        type: string;
        capabilities: {
            canImport: boolean;
            canCreate: boolean;
            canDelete: boolean;
        };
    }[];

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        const clientSecret =
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
        authToken = await getToken(app, clientId, clientSecret);

        const res = await request(app.getHttpServer())
            .get("/key-chain/providers")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        availableProviders = res.body.providers;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("should list at least one KMS provider", () => {
        expect(availableProviders.length).toBeGreaterThanOrEqual(1);
    });

    test.each(["db", "vault"])(
        "%s — full key chain lifecycle (create → get → list → delete)",
        async (providerName) => {
            const provider = availableProviders.find(
                (p) => p.name === providerName,
            );

            if (!provider) {
                console.log(`Skipping "${providerName}" — not configured`);
                return;
            }

            if (!provider.capabilities.canCreate) {
                console.log(
                    `Skipping "${providerName}" — does not support key generation`,
                );
                return;
            }

            // 1. Create a key chain
            const createRes = await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    type: KeyChainType.Standalone,
                    usageType: "access",
                    kmsProvider: providerName,
                    description: `e2e test key chain (${providerName})`,
                })
                .expect(201);

            const keyChainId = createRes.body.id;
            expect(keyChainId).toBeDefined();
            expect(typeof keyChainId).toBe("string");

            // 2. Retrieve the key chain by ID
            const getRes = await request(app.getHttpServer())
                .get(`/key-chain/${keyChainId}`)
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

            expect(getRes.body.id).toBe(keyChainId);
            expect(getRes.body.kmsProvider).toBe(providerName);

            // 3. Key chain should appear in the list
            const listRes = await request(app.getHttpServer())
                .get("/key-chain")
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

            const listed = listRes.body.find((k: any) => k.id === keyChainId);
            expect(listed).toBeDefined();

            // 4. Delete the key chain
            if (provider.capabilities.canDelete) {
                await request(app.getHttpServer())
                    .delete(`/key-chain/${keyChainId}`)
                    .set("Authorization", `Bearer ${authToken}`)
                    .expect(204);

                // Verify it's gone
                await request(app.getHttpServer())
                    .get(`/key-chain/${keyChainId}`)
                    .set("Authorization", `Bearer ${authToken}`)
                    .expect(404);
            }
        },
    );
});
