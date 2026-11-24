import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { mockKms, startKmsServer } from "../shared/http-kms-mock.js";
import { getToken } from "../utils.js";
import { expectCertificateSignedBy } from "../utils-ec.js";

const PROVIDER_ID = "kms-reference";

describe("Key Chain — HTTP KMS adapter (e2e)", () => {
    let kmsServer: Server;
    let app: INestApplication;
    let authToken: string;

    beforeAll(async () => {
        // 1. Start the in-process KMS server on a random OS-assigned port
        const { server, baseUrl } = await startKmsServer();
        kmsServer = server;

        // 2. Write a temp kms.json pointing at the running server
        const tmpConfigDir = mkdtempSync(
            join(tmpdir(), "eudiplo-http-kms-test-"),
        );
        writeFileSync(
            join(tmpConfigDir, "kms.json"),
            JSON.stringify({
                defaultProvider: PROVIDER_ID,
                providers: [
                    { id: "db", type: "db" },
                    {
                        id: PROVIDER_ID,
                        type: "http",
                        baseUrl,
                        canImport: true,
                        algorithms: ["ES256", "ES384"],
                    },
                ],
            }),
        );

        // 3. Boot the NestJS app with CONFIG_FOLDER pointing at our temp dir
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
    });

    afterAll(async () => {
        await app?.close();
        await new Promise<void>((resolve) => kmsServer?.close(() => resolve()));
    });

    test("http provider is listed with correct capabilities", async () => {
        const res = await request(app.getHttpServer())
            .get("/key-chain/providers")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const provider = res.body.providers.find(
            (p: { name: string }) => p.name === PROVIDER_ID,
        );
        expect(provider).toBeDefined();
        expect(provider.capabilities.canCreate).toBe(true);
        expect(provider.capabilities.canImport).toBe(true);
        expect(provider.capabilities.canDelete).toBe(true);
        expect(provider.capabilities.supportedAlgs).toEqual(["ES256", "ES384"]);
        expect(provider.capabilities.defaultAlg).toBe("ES256");
    });

    test("http provider health check passes", async () => {
        const res = await request(app.getHttpServer())
            .get("/key-chain/providers/health")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const providerHealth = res.body.find(
            (p: { providerId: string }) => p.providerId === PROVIDER_ID,
        );
        expect(providerHealth).toBeDefined();
        expect(providerHealth.ok).toBe(true);
    });

    test("create → get → list → delete key chain via http kms", async () => {
        // Create
        const createRes = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                type: KeyChainType.Standalone,
                usageType: "access",
                kmsProvider: PROVIDER_ID,
                description: "http kms e2e test key chain",
            })
            .expect(201);

        const keyChainId: string = createRes.body.id;
        expect(keyChainId).toBeDefined();

        // Get by ID
        const getRes = await request(app.getHttpServer())
            .get(`/key-chain/${keyChainId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(getRes.body.id).toBe(keyChainId);
        expect(getRes.body.kmsProvider).toBe(PROVIDER_ID);

        // Should appear in list
        const listRes = await request(app.getHttpServer())
            .get("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(
            listRes.body.find((k: { id: string }) => k.id === keyChainId),
        ).toBeDefined();

        // Delete
        await request(app.getHttpServer())
            .delete(`/key-chain/${keyChainId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(204);

        // Confirm gone
        await request(app.getHttpServer())
            .get(`/key-chain/${keyChainId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(404);
    });

    test("creates an ES384 internal chain whose certificates verify", async () => {
        const createRes = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                type: KeyChainType.InternalChain,
                usageType: "attestation",
                kmsProvider: PROVIDER_ID,
                alg: "ES384",
            })
            .expect(201);

        const keyChain = await request(app.getHttpServer())
            .get(`/key-chain/${createRes.body.id}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(keyChain.body.alg).toBe("ES384");
        expect(keyChain.body.activePublicKey.crv).toBe("P-384");
        expectCertificateSignedBy(keyChain.body.rootCertificate.pem, "ES384");
        expectCertificateSignedBy(
            keyChain.body.activeCertificate.pem,
            "ES384",
            keyChain.body.rootCertificate.pem,
        );
    });

    test("imports a P-384 key through the http provider as ES384", async () => {
        const privateJwk = generateKeyPairSync("ec", {
            namedCurve: "secp384r1",
        }).privateKey.export({ format: "jwk" });
        const importRes = await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                key: privateJwk,
                usageType: "attestation",
                kmsProvider: PROVIDER_ID,
            })
            .expect(201);

        const keyChain = await request(app.getHttpServer())
            .get(`/key-chain/${importRes.body.id}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(keyChain.body.alg).toBe("ES384");
        expect(keyChain.body.activePublicKey).toMatchObject({
            crv: "P-384",
            x: privateJwk.x,
        });
        expectCertificateSignedBy(keyChain.body.activeCertificate.pem, "ES384");
    });

    test("refuses to import a P-521 key, which the provider does not allow", async () => {
        const privateJwk = generateKeyPairSync("ec", {
            namedCurve: "secp521r1",
        }).privateKey.export({ format: "jwk" });
        const before = await request(app.getHttpServer())
            .get("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const importsBefore = mockKms.importCount;
        const res = await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                key: privateJwk,
                usageType: "attestation",
                kmsProvider: PROVIDER_ID,
            });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(
            `KMS provider '${PROVIDER_ID}' does not offer ES512 for the imported key. Supported: ES256, ES384`,
        );
        expect(mockKms.importCount).toBe(importsBefore);
        const after = await request(app.getHttpServer())
            .get("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(after.body).toHaveLength(before.body.length);
    });

    test("refuses ES512, which the provider does not allow", async () => {
        await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                type: KeyChainType.Standalone,
                usageType: "attestation",
                kmsProvider: PROVIDER_ID,
                alg: "ES512",
            })
            .expect(400);
    });

    test("rejects a P-256 key returned for ES384 and stores no key chain", async () => {
        const listIds = async () =>
            (
                await request(app.getHttpServer())
                    .get("/key-chain")
                    .set("Authorization", `Bearer ${authToken}`)
                    .expect(200)
            ).body.map((keyChain: { id: string }) => keyChain.id);
        const before = await listIds();

        mockKms.curveOverride = "P-256";
        mockKms.signCount = 0;
        try {
            const res = await request(app.getHttpServer())
                .post("/key-chain")
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    type: KeyChainType.Standalone,
                    usageType: "attestation",
                    kmsProvider: PROVIDER_ID,
                    alg: "ES384",
                });
            expect(res.status).toBe(500);
        } finally {
            delete mockKms.curveOverride;
        }

        expect(await listIds()).toEqual(before);
        // Refused when the key is returned, before the certificate is signed.
        expect(mockKms.signCount).toBe(0);
    });
});
