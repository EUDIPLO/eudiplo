import "reflect-metadata";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { decodeJwt, decodeProtectedHeader, importX509, jwtVerify } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { TrustListService } from "../../src/issuer/trust-list/trustlist.service.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { getToken, readConfig } from "../utils.js";

interface TestContext {
    app: INestApplication<App>;
    authToken: string;
    configFolder: string;
}

describe("Trust List e2e Tests", () => {
    let ctx: TestContext;

    beforeAll(async () => {
        // Delete the database
        rmSync("../../tmp/service.db", { force: true });

        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        const app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());

        const configService = app.get(ConfigService);
        const configFolder = resolve(__dirname + "/../fixtures");
        configService.set("CONFIG_IMPORT_MODE", "disabled");
        configService.set("LOG_LEVEL", "debug");
        const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        const clientSecret =
            configService.getOrThrow<string>("AUTH_CLIENT_SECRET");

        console.log("client:", clientId, clientSecret);
        await app.init();
        await app.listen(3000);

        const authToken = await getToken(app, clientId, clientSecret);

        // Import trust list key chain
        const trustListKeyChain = readConfig<KeyChainImportDto>(
            join(configFolder, "haip/key-chains/trust-list.json"),
        );
        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(trustListKeyChain)
            .expect(201);

        // Import attestation key chain (for internal entity issuance references)
        const attestationKeyChain = readConfig<KeyChainImportDto>(
            join(configFolder, "haip/key-chains/attestation.json"),
        );
        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(attestationKeyChain)
            .expect(201);

        // Import status list key chain (for internal entity revocation references)
        const statusListKeyChain = readConfig<KeyChainImportDto>(
            join(configFolder, "haip/key-chains/status-list.json"),
        );
        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(statusListKeyChain)
            .expect(201);

        ctx = { app, authToken, configFolder };
    });

    afterAll(async () => {
        await ctx?.app?.close();
    });

    describe("CRUD Operations", () => {
        const testTrustListId = "test-crud-trust-list";

        test("should create a trust list", async () => {
            const createDto: TrustListCreateDto = {
                id: testTrustListId,
                description: "Test Trust List for CRUD",
                keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: {
                            name: "Test Provider",
                            lang: "en",
                        },
                    },
                ],
            };

            const response = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(201);

            expect(response.body.id).toBe(testTrustListId);
            expect(response.body.description).toBe("Test Trust List for CRUD");
            expect(response.body.jwt).toBeDefined();
            expect(response.body.sequenceNumber).toBe(1);
        });

        test("should get all trust lists", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBeGreaterThanOrEqual(1);
        });

        test("should get a single trust list by id", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${testTrustListId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            expect(response.body.id).toBe(testTrustListId);
        });

        test("should update a trust list and increment sequence number", async () => {
            const updateDto: TrustListCreateDto = {
                description: "Updated Test Trust List",
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: {
                            name: "Updated Provider",
                            lang: "en",
                        },
                    },
                ],
            };

            const response = await request(ctx.app.getHttpServer())
                .put(`/trust-list/${testTrustListId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(updateDto)
                .expect(200);

            expect(response.body.description).toBe("Updated Test Trust List");
            expect(response.body.sequenceNumber).toBe(2);
        });

        test("should export a trust list in LoTE format", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${testTrustListId}/export`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            expect(response.body.id).toBe(testTrustListId);
            expect(response.body.entities).toBeDefined();
            expect(response.body.data).toBeDefined();
        });

        test("should get version history for a trust list", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${testTrustListId}/versions`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
            // Should have at least one version from the update
            expect(response.body.length).toBeGreaterThanOrEqual(1);
        });

        test("should delete a trust list", async () => {
            await request(ctx.app.getHttpServer())
                .delete(`/trust-list/${testTrustListId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(204);

            // Verify it's deleted
            await request(ctx.app.getHttpServer())
                .get(`/trust-list/${testTrustListId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(409);
        });
    });

    describe("LoTE JWT Signing", () => {
        const jwtTestId = "jwt-signing-test";

        test("should create trust list with valid JWT structure", async () => {
            const createDto: TrustListCreateDto = {
                id: jwtTestId,
                description: "JWT Signing Test",
                keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: {
                            name: "JWT Test Provider",
                            lang: "en",
                        },
                    },
                ],
            };

            const response = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(201);

            const jwt = response.body.jwt;
            expect(jwt).toBeDefined();

            // Decode and verify JWT structure
            const header = decodeProtectedHeader(jwt);
            expect(header.alg).toBe("ES256");
            expect(header.x5c).toBeDefined();
            expect(Array.isArray(header.x5c)).toBe(true);
            expect((header.x5c as string[]).length).toBeGreaterThanOrEqual(1);

            // Decode payload and verify LoTE structure
            const payload = decodeJwt<{ LoTE: unknown }>(jwt);
            expect(payload.LoTE).toBeDefined();
        });

        test("should include ETSI TS 119 602 compliant LoTE structure in JWT", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${jwtTestId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            const payload = decodeJwt<{
                LoTE: {
                    ListAndSchemeInformation: {
                        LoTEVersionIdentifier: number;
                        LoTESequenceNumber: number;
                        LoTEType: string;
                        SchemeTerritory: string;
                    };
                    TrustedEntitiesList: unknown[];
                };
            }>(response.body.jwt);

            const lote = payload.LoTE;
            expect(lote.ListAndSchemeInformation).toBeDefined();
            expect(
                lote.ListAndSchemeInformation.LoTEVersionIdentifier,
            ).toBeDefined();
            expect(
                lote.ListAndSchemeInformation.LoTESequenceNumber,
            ).toBeDefined();
            expect(lote.ListAndSchemeInformation.LoTEType).toBe(
                "http://uri.etsi.org/19602/LoTEType/EUEAAProvidersList",
            );
            expect(lote.TrustedEntitiesList).toBeDefined();
        });

        test("should verify JWT signature with embedded certificate", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${jwtTestId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            const jwt = response.body.jwt;
            const header = decodeProtectedHeader(jwt);
            const x5c = header.x5c as string[];

            // Import the certificate from x5c and verify the signature
            const certPem = `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`;
            const publicKey = await importX509(certPem, "ES256");

            const { payload } = await jwtVerify(jwt, publicKey);
            expect(payload.LoTE).toBeDefined();
        });
    });

    describe("LoTE Parsing and Entity Count", () => {
        const parsingTestId = "parsing-test";

        test("should correctly count TrustedEntities in the list", async () => {
            // Create trust list with multiple entities
            const createDto: TrustListCreateDto = {
                id: parsingTestId,
                description: "Parsing Test",
                keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: { name: "Provider 1", lang: "en" },
                    },
                ],
            };

            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(201);

            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${parsingTestId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            const payload = decodeJwt<{
                LoTE: { TrustedEntitiesList: unknown[] };
            }>(response.body.jwt);
            expect(payload.LoTE.TrustedEntitiesList.length).toBe(1);
        });

        test("should include issuance and revocation services per entity", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${parsingTestId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            const payload = decodeJwt<{
                LoTE: {
                    TrustedEntitiesList: Array<{
                        TrustedEntityServices: Array<{
                            ServiceInformation: {
                                ServiceTypeIdentifier: string;
                            };
                        }>;
                    }>;
                };
            }>(response.body.jwt);

            const entity = payload.LoTE.TrustedEntitiesList[0];
            const serviceTypes = entity.TrustedEntityServices.map(
                (s) => s.ServiceInformation.ServiceTypeIdentifier,
            );

            // Should have both issuance and revocation services
            expect(serviceTypes.some((t) => t.includes("Issuance"))).toBe(true);
            expect(serviceTypes.some((t) => t.includes("Revocation"))).toBe(
                true,
            );
        });
    });

    describe("Public URL Resolution", () => {
        const publicUrlTestId = "public-url-test";

        beforeAll(async () => {
            const createDto: TrustListCreateDto = {
                id: publicUrlTestId,
                description: "Public URL Test",
                keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: { name: "Public URL Provider", lang: "en" },
                    },
                ],
            };

            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(201);
        });

        test("should return JWT from public URL endpoint", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/issuers/root/trust-list/${publicUrlTestId}`)
                .expect(200);

            // Response should be the raw JWT string
            expect(typeof response.text).toBe("string");
            expect(response.text.split(".").length).toBe(3); // JWT has 3 parts
        });

        test("should return same JWT from public and authenticated endpoints", async () => {
            const publicResponse = await request(ctx.app.getHttpServer())
                .get(`/issuers/root/trust-list/${publicUrlTestId}`)
                .expect(200);

            const authResponse = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${publicUrlTestId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            expect(publicResponse.text).toBe(authResponse.body.jwt);
        });

        test("should return 400 for non-existent trust list via public URL", async () => {
            await request(ctx.app.getHttpServer())
                .get("/issuers/root/trust-list/non-existent-id")
                .expect(400);
        });
    });

    describe("Renewal", () => {
        const renewalTestId = "renewal-test";

        test("re-issues a list in its renewal window with the next sequence number", async () => {
            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    id: renewalTestId,
                    keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId:
                                "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                            revocationKeyChainId:
                                "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                            info: { name: "Renewal Provider", lang: "en" },
                        },
                    ],
                } satisfies TrustListCreateDto)
                .expect(201);

            // Run the scheduled renewal as it would run 25 days from now.
            const later = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
            await ctx.app.get(TrustListService).renewDueTrustLists(later);

            const jwt = (
                await request(ctx.app.getHttpServer())
                    .get(`/issuers/root/trust-list/${renewalTestId}`)
                    .expect(200)
            ).text;
            const x5c = decodeProtectedHeader(jwt).x5c as string[];
            const { payload } = await jwtVerify<{
                LoTE: {
                    ListAndSchemeInformation: {
                        LoTESequenceNumber: number;
                        NextUpdate: string;
                    };
                };
            }>(
                jwt,
                await importX509(
                    `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`,
                    "ES256",
                ),
            );
            expect(payload.LoTE.ListAndSchemeInformation).toMatchObject({
                LoTESequenceNumber: 2,
                NextUpdate: new Date(
                    later.getTime() + 30 * 24 * 60 * 60 * 1000,
                ).toISOString(),
            });

            const versions = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${renewalTestId}/versions`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);
            expect(
                versions.body.map(
                    (version: { sequenceNumber: number }) =>
                        version.sequenceNumber,
                ),
            ).toEqual([1]);
        });
    });

    describe("Error Handling", () => {
        test("should reject unknown fields", async () => {
            const res = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    id: "unknown-field-test",
                    keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                    entites: [],
                })
                .expect(400);
            expect(JSON.stringify(res.body.errors)).toContain("entites");
        });

        test("should reject trust list with invalid key chain id", async () => {
            const createDto: TrustListCreateDto = {
                id: "invalid-keychain-test",
                description: "Invalid Key Chain Test",
                keyChainId: "non-existent-key-chain",
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: { name: "Test Provider", lang: "en" },
                    },
                ],
            };

            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(409);
        });

        test("should reject trust list with key chain that lacks TrustList usage", async () => {
            // attestation key chain has Attestation usage, not TrustList
            const createDto: TrustListCreateDto = {
                id: "wrong-usage-test",
                description: "Wrong Usage Test",
                keyChainId: "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad", // attestation key
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: { name: "Test Provider", lang: "en" },
                    },
                ],
            };

            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(409);
        });

        test("should reject external entity with invalid PEM certificate", async () => {
            const createDto: TrustListCreateDto = {
                id: "invalid-pem-test",
                description: "Invalid PEM Test",
                entities: [
                    {
                        type: "external",
                        issuerCertPem: "not-a-valid-pem",
                        revocationCertPem: "also-not-valid",
                        info: { name: "Invalid Provider" },
                    },
                ],
            };

            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(409);
        });

        test("should return 409 when getting non-existent trust list", async () => {
            await request(ctx.app.getHttpServer())
                .get("/trust-list/does-not-exist")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(409);
        });
    });

    describe("Authentication", () => {
        test("should reject unauthenticated request to create trust list", async () => {
            const createDto: TrustListCreateDto = {
                id: "unauth-test",
                description: "Unauthenticated Test",
                entities: [],
            };

            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .send(createDto)
                .expect(401);
        });

        test("should reject unauthenticated request to list trust lists", async () => {
            await request(ctx.app.getHttpServer())
                .get("/trust-list")
                .expect(401);
        });

        test("public URL should be accessible without authentication", async () => {
            // First create a trust list
            const createDto: TrustListCreateDto = {
                id: "public-access-test",
                description: "Public Access Test",
                keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: { name: "Public Access Provider", lang: "en" },
                    },
                ],
            };

            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(201);

            // Public URL should work without auth
            const response = await request(ctx.app.getHttpServer())
                .get("/issuers/root/trust-list/public-access-test")
                .expect(200);

            expect(response.text.split(".").length).toBe(3);
        });
    });
});
