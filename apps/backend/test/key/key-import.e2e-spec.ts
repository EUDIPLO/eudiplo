import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { getTenantAdminToken, getToken } from "../utils.js";

describe("Key Chain — Import (e2e)", () => {
    let app: INestApplication;
    let authToken: string;
    let tenantAdminToken: string;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe());
        await app.init();

        const configService = app.get(ConfigService);
        const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        const clientSecret =
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
        authToken = await getToken(app, clientId, clientSecret);

        // A second tenant whose client holds tenant:admin, the role that is
        // allowed to export private key material.
        tenantAdminToken = await getTenantAdminToken(
            app,
            clientId,
            clientSecret,
            "key-export-admin",
        );
    });

    const privateKey = {
        kty: "EC",
        x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
        y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
        crv: "P-256",
        d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
        alg: "ES256",
    };

    async function importKeyChain(token: string): Promise<string> {
        const keyId = v4();
        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${token}`)
            .send({
                id: keyId,
                key: { ...privateKey, kid: keyId },
                usageType: KeyUsageType.Attestation,
            } satisfies KeyChainImportDto)
            .expect(201);
        return keyId;
    }

    afterAll(async () => {
        await app?.close();
    });

    test("import a new key chain", async () => {
        const keyId = v4();
        const privateKey = {
            kty: "EC",
            x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
            y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
            crv: "P-256",
            d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
            kid: keyId,
            alg: "ES256",
        };

        const payload: KeyChainImportDto = {
            id: keyId,
            key: privateKey,
            usageType: KeyUsageType.Attestation,
            description: "Test key chain",
        };
        const creationResponse = await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(payload)
            .expect(201);

        expect(creationResponse.body.id).toBe(keyId);

        const getResponse = await request(app.getHttpServer())
            .get("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const foundKeyChain = getResponse.body.find(
            (keyChain) => keyChain.id === keyId,
        );
        expect(foundKeyChain).toBeDefined();
        expect(
            getResponse.body.some(
                (keyChain) => keyChain.usageType === KeyUsageType.Encrypt,
            ),
        ).toBe(false);
    });

    describe("export", () => {
        test("rejects callers that only manage issuance or presentation resources", async () => {
            const keyId = await importKeyChain(authToken);

            const response = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${authToken}`)
                .expect(403);

            expect(JSON.stringify(response.body)).not.toContain(privateKey.d);
        });

        test("returns the private key to tenant administrators", async () => {
            const keyId = await importKeyChain(tenantAdminToken);

            const response = await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(200);

            expect(response.body.id).toBe(keyId);
            expect(response.body.key.d).toBe(privateKey.d);
        });

        test("does not export key chains of another tenant", async () => {
            const keyId = await importKeyChain(authToken);

            await request(app.getHttpServer())
                .get(`/key-chain/${keyId}/export`)
                .set("Authorization", `Bearer ${tenantAdminToken}`)
                .expect(404);
        });
    });
});
