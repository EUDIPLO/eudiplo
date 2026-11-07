import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import {
    TRUST_LIST_COUNTRY_MESSAGE,
    TRUST_LIST_EMAIL_MESSAGE,
    TRUST_LIST_LANGUAGE_MESSAGE,
    TRUST_LIST_PHONE_MESSAGE,
    TRUST_LIST_URI_MESSAGE,
    TRUST_LIST_WEBSITE_MESSAGE,
} from "@eudiplo/config-format/trust-list-entity-info.js";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import {
    decodeJwt,
    decodeProtectedHeader,
    exportJWK,
    generateKeyPair,
    importX509,
    jwtVerify,
} from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { TrustListService } from "../../src/issuer/trust-list/trustlist.service.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { documentsBundle } from "../shared/config-bundle.js";
import { getTenantAdminToken, getToken, readConfig } from "../utils.js";
import {
    createKeyChain,
    deleteKeyChain,
    expectJwsSignedWithX5c,
} from "../utils-ec.js";

interface TestContext {
    app: INestApplication<App>;
    authToken: string;
    configFolder: string;
    clientId: string;
    clientSecret: string;
}

/** A new P-256 private key for `POST /key-chain/import`. */
async function newPrivateKey(): Promise<KeyChainImportDto["key"]> {
    const { privateKey } = await generateKeyPair("ES256", {
        extractable: true,
    });
    return {
        ...(await exportJWK(privateKey)),
        alg: "ES256",
    } as KeyChainImportDto["key"];
}

/** Imports `key` as key chain `id`, replacing a key chain with that id. */
function importKeyChain(
    app: INestApplication<App>,
    token: string,
    body: Pick<KeyChainImportDto, "id" | "key" | "usageType">,
) {
    return request(app.getHttpServer())
        .post("/key-chain/import")
        .set("Authorization", `Bearer ${token}`)
        .send(body satisfies KeyChainImportDto)
        .expect(201);
}

/**
 * Imports the attestation and status list key chains of the HAIP fixtures,
 * which internal entities need as issuer and revocation key chains.
 */
async function importEntityKeyChains(
    app: INestApplication<App>,
    token: string,
    configFolder: string,
): Promise<void> {
    for (const file of ["attestation", "status-list"]) {
        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${token}`)
            .send(
                readConfig<KeyChainImportDto>(
                    join(configFolder, `haip/key-chains/${file}.json`),
                ),
            )
            .expect(201);
    }
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

        ctx = { app, authToken, configFolder, clientId, clientSecret };
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
                            contactUri: "info@example.com",
                            website: "https://example.com/",
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
                            contactUri: "info@example.com",
                            website: "https://example.com/",
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
            // The update names no keyChainId; the list stays on its key chain.
            expect(response.body.keyChainId).toBe(
                "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
            );
        });

        test("should export a trust list in the create format", async () => {
            const response = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${testTrustListId}/export`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            expect(response.body.id).toBe(testTrustListId);
            expect(response.body.entities).toBeDefined();
            expect(response.body.data).toBeDefined();
        });

        test("should re-import the export of a trust list created without a description", async () => {
            const id = "no-description-trust-list";
            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    id,
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
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                            },
                        },
                    ],
                } satisfies TrustListCreateDto)
                .expect(201);

            const exported = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${id}/export`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);

            // POST /trust-list drops a null optional field itself; the config
            // folder import validates strictly, so the export must leave it out.
            expect(exported.body).not.toHaveProperty("description");

            await request(ctx.app.getHttpServer())
                .delete(`/trust-list/${id}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(204);
            const reimported = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(exported.body)
                .expect(201);

            expect(reimported.body.id).toBe(id);
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

        test("reads a stored version only under its own list", async () => {
            const server = ctx.app.getHttpServer();
            const auth = `Bearer ${ctx.authToken}`;
            const history = await request(server)
                .get(`/trust-list/${testTrustListId}/versions`)
                .set("Authorization", auth)
                .expect(200);
            const oldest = history.body.at(-1);

            const version = await request(server)
                .get(`/trust-list/${testTrustListId}/versions/${oldest.id}`)
                .set("Authorization", auth)
                .expect(200);
            expect(version.body).toMatchObject({
                id: oldest.id,
                trustListId: testTrustListId,
                sequenceNumber: 1,
            });

            const other = await request(server)
                .get(`/trust-list/does-not-exist/versions/${oldest.id}`)
                .set("Authorization", auth)
                .expect(404);
            expect(other.body.message).toBe("Trust list version not found");
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
                .expect(404);
        });
    });

    describe("Updates without keyChainId", () => {
        const listId = "kept-key-chain-trust-list";
        const keyChainId = randomUUID();
        const entities: TrustListCreateDto["entities"] = [
            {
                type: "internal",
                issuerKeyChainId: "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                revocationKeyChainId: "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                info: {
                    name: "Kept Key Chain Provider",
                    contactUri: "info@example.com",
                    website: "https://example.com/",
                    lang: "en",
                },
            },
        ];
        let key: KeyChainImportDto["key"];

        const sequenceNumber = async () =>
            (
                await request(ctx.app.getHttpServer())
                    .get(`/trust-list/${listId}`)
                    .set("Authorization", `Bearer ${ctx.authToken}`)
                    .expect(200)
            ).body.sequenceNumber;

        beforeAll(async () => {
            key = await newPrivateKey();
            // The list's own trust list key chain, besides the tenant's
            // default one.
            await importKeyChain(ctx.app, ctx.authToken, {
                id: keyChainId,
                key,
                usageType: KeyUsageType.TrustList,
            });
            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({ id: listId, keyChainId, entities })
                .expect(201);
        });

        afterAll(async () => {
            // Later tests rely on the default trust list key chain.
            await request(ctx.app.getHttpServer())
                .delete(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(204);
            await deleteKeyChain(ctx.app, ctx.authToken, keyChainId);
        });

        test("keep the key chain the list is signed with", async () => {
            const before = await sequenceNumber();

            const response = await request(ctx.app.getHttpServer())
                .put(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({ entities })
                .expect(200);

            expect(response.body.keyChainId).toBe(keyChainId);
            expect(response.body.sequenceNumber).toBe(before + 1);
        });

        test("refuse a kept key chain that an import gave another usage type", async () => {
            const before = await sequenceNumber();
            await importKeyChain(ctx.app, ctx.authToken, {
                id: keyChainId,
                key,
                usageType: KeyUsageType.Attestation,
            });

            const refused = await request(ctx.app.getHttpServer())
                .put(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({ entities })
                .expect(409);
            expect(refused.body.message).toBe(
                `Key chain ${keyChainId} of this trust list is not valid for Trust List usage (key lacks TrustList usage). Name a key chain with usage type trustList in keyChainId.`,
            );
            const stored = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);
            expect(stored.body.sequenceNumber).toBe(before);
            expect(stored.body.keyChainId).toBe(keyChainId);

            // The scheduled renewal still signs with the kept key chain.
            await ctx.app
                .get(TrustListService)
                .renewDueTrustLists(
                    new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
                );
            const renewed = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);
            expect(renewed.body.sequenceNumber).toBe(before + 1);
            expect(renewed.body.keyChainId).toBe(keyChainId);

            // Naming a trust list key chain moves the list to it.
            const moved = await request(ctx.app.getHttpServer())
                .put(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                    entities,
                })
                .expect(200);
            expect(moved.body.keyChainId).toBe(
                "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
            );
            expect(moved.body.sequenceNumber).toBe(before + 2);
        });
    });

    describe("Bundle import of a list without keyChainId", () => {
        const tenant = "trust-list-bundle-key-chain";
        const listId = "bundle-trust-list";
        const keyChainId = randomUUID();
        const keptRefusal = `Key chain ${keyChainId} of this trust list is not valid for Trust List usage (key lacks TrustList usage). Name a key chain with usage type trustList in keyChainId.`;
        let token: string;
        let auth: string;
        let key: KeyChainImportDto["key"];
        /** The exported list without `keyChainId`. */
        let spec: Record<string, unknown>;

        /**
         * A bundle with list `id`, the exported list changed by `changes`,
         * and, with `usageType`, the list's key chain with that usage type.
         */
        const listBundle = (
            changes: Record<string, unknown> = {},
            usageType?: KeyUsageType,
            id = listId,
        ) =>
            documentsBundle(tenant, [
                ...(usageType
                    ? [
                          {
                              kind: "KeyChain" as const,
                              id: keyChainId,
                              path: `key-chains/${keyChainId}.json`,
                              spec: {
                                  id: keyChainId,
                                  usageType,
                                  keySource: { type: "private-jwk", jwk: key },
                              },
                              // Above the generations the API imports gave it.
                              generation: 100,
                          },
                      ]
                    : []),
                {
                    kind: "TrustList",
                    id,
                    path: `trust-lists/${id}.json`,
                    spec: { ...spec, ...changes, id },
                },
            ]);
        const plan = async (
            bundle: ConfigBundle,
            mode: "upsert" | "create" = "upsert",
        ): Promise<ConfigImportPlan> =>
            (
                await request(ctx.app.getHttpServer())
                    .post(`/config-bundles/plan?mode=${mode}`)
                    .set("Authorization", auth)
                    .send(bundle)
                    .expect(201)
            ).body;
        const importBundle = (
            bundle: ConfigBundle,
            planned: ConfigImportPlan,
            status: number,
        ) =>
            request(ctx.app.getHttpServer())
                .post(
                    `/config-bundles/import?mode=upsert&planFingerprint=${planned.planFingerprint}`,
                )
                .set("Authorization", auth)
                .send(bundle)
                .expect(status);
        const listItem = (planned: ConfigImportPlan, id = listId) =>
            planned.items.find(
                (item) => item.kind === "TrustList" && item.id === id,
            );
        const keyChainItem = (planned: ConfigImportPlan) =>
            planned.items.find(
                (item) => item.kind === "KeyChain" && item.id === keyChainId,
            );
        const storedList = async () =>
            (
                await request(ctx.app.getHttpServer())
                    .get(`/trust-list/${listId}`)
                    .set("Authorization", auth)
                    .expect(200)
            ).body;
        const storedUsageType = async () =>
            (
                await request(ctx.app.getHttpServer())
                    .get(`/key-chain/${keyChainId}`)
                    .set("Authorization", auth)
                    .expect(200)
            ).body.usageType;

        beforeAll(async () => {
            token = await getTenantAdminToken(
                ctx.app,
                ctx.clientId,
                ctx.clientSecret,
                tenant,
                [Role.Issuances, Role.Keys],
            );
            auth = `Bearer ${token}`;
            await importEntityKeyChains(ctx.app, token, ctx.configFolder);
            key = await newPrivateKey();
            await importKeyChain(ctx.app, token, {
                id: keyChainId,
                key,
                usageType: KeyUsageType.TrustList,
            });
            await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", auth)
                .send({
                    id: listId,
                    description: "Before the bundle",
                    keyChainId,
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId:
                                "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                            revocationKeyChainId:
                                "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                            info: {
                                name: "Bundle Provider",
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                            },
                        },
                    ],
                } satisfies TrustListCreateDto)
                .expect(201);
            const exported = await request(ctx.app.getHttpServer())
                .get(`/trust-list/${listId}/export`)
                .set("Authorization", auth)
                .expect(200);
            const { keyChainId: _signing, ...rest } = exported.body;
            spec = rest;
            await importKeyChain(ctx.app, token, {
                id: keyChainId,
                key,
                usageType: KeyUsageType.Attestation,
            });
        });

        test("the plan blocks a change once the kept key chain lost trustList usage", async () => {
            const bundle = listBundle({ description: "Changed by a bundle" });

            const planned = await plan(bundle);

            expect(planned.applicable).toBe(false);
            expect(listItem(planned)).toMatchObject({
                action: "blocked",
                issues: [
                    {
                        severity: "error",
                        code: "KEY_CHAIN_USAGE_MISMATCH",
                        path: "/spec/keyChainId",
                        message: keptRefusal,
                        resource: { kind: "TrustList", id: listId },
                    },
                ],
            });
            const refused = await importBundle(bundle, planned, 400);
            expect(refused.body.code).toBe("CONFIG_APPLY_BLOCKED");
            expect(await storedList()).toMatchObject({
                description: "Before the bundle",
                keyChainId,
                sequenceNumber: 1,
            });
        });

        test("the plan blocks a change that names the key chain", async () => {
            const planned = await plan(
                listBundle({ description: "Changed by a bundle", keyChainId }),
            );

            expect(planned.applicable).toBe(false);
            expect(listItem(planned)?.issues).toEqual([
                expect.objectContaining({
                    severity: "error",
                    code: "KEY_CHAIN_USAGE_MISMATCH",
                    path: "/spec/keyChainId",
                    message: `Key chain ${keyChainId} is not valid for Trust List usage (key lacks TrustList usage)`,
                }),
            ]);
        });

        test("the plan does not check a list that create mode skips", async () => {
            const planned = await plan(
                listBundle({ description: "Changed by a bundle" }),
                "create",
            );

            expect(planned.applicable, JSON.stringify(planned)).toBe(true);
            expect(listItem(planned)).toMatchObject({
                action: "skip",
                issues: [expect.objectContaining({ code: "RESOURCE_EXISTS" })],
            });
        });

        test("the plan reports a missing keyChainId only as a missing reference", async () => {
            const missing = randomUUID();

            const planned = await plan(listBundle({ keyChainId: missing }));

            expect(listItem(planned)?.issues).toEqual([
                expect.objectContaining({
                    code: "MISSING_RESOURCE_REFERENCE",
                    path: "/spec/keyChainId",
                }),
            ]);
        });

        test("the plan ignores the usage type of a key chain document it skips", async () => {
            // Create mode skips the stored key chain, so its attestation
            // usage stays and blocks a new list that names it.
            const newListId = "bundle-trust-list-new";
            const planned = await plan(
                listBundle({ keyChainId }, KeyUsageType.TrustList, newListId),
                "create",
            );

            expect(planned.applicable).toBe(false);
            expect(keyChainItem(planned)).toMatchObject({ action: "skip" });
            expect(listItem(planned, newListId)).toMatchObject({
                action: "blocked",
                issues: [
                    expect.objectContaining({
                        code: "KEY_CHAIN_USAGE_MISMATCH",
                        message: `Key chain ${keyChainId} is not valid for Trust List usage (key lacks TrustList usage)`,
                    }),
                ],
            });
        });

        test("the plan only warns for a list the bundle leaves unchanged", async () => {
            for (const changes of [{}, { keyChainId }]) {
                const bundle = listBundle(changes);

                const planned = await plan(bundle);

                expect(planned.applicable, JSON.stringify(planned)).toBe(true);
                expect(listItem(planned)).toMatchObject({
                    action: "unchanged",
                    issues: [
                        {
                            severity: "warning",
                            code: "KEY_CHAIN_USAGE_MISMATCH",
                            path: "/spec/keyChainId",
                        },
                    ],
                });
                await importBundle(bundle, planned, 201);
            }
            expect(await storedList()).toMatchObject({
                description: "Before the bundle",
                keyChainId,
                sequenceNumber: 1,
            });
        });

        test("the plan takes the usage type from a key chain document of the same bundle", async () => {
            // Taking trustList usage away in the same bundle blocks the
            // list, so the key chain document is not applied either.
            await importKeyChain(ctx.app, token, {
                id: keyChainId,
                key,
                usageType: KeyUsageType.TrustList,
            });
            const takenAway = listBundle(
                { description: "Changed by a bundle" },
                KeyUsageType.Attestation,
            );
            const blocked = await plan(takenAway);
            expect(blocked.applicable).toBe(false);
            expect(keyChainItem(blocked)).toMatchObject({
                action: "update",
                issues: [],
            });
            expect(listItem(blocked)?.issues).toEqual([
                expect.objectContaining({
                    code: "KEY_CHAIN_USAGE_MISMATCH",
                    message: keptRefusal,
                }),
            ]);
            await importBundle(takenAway, blocked, 400);
            expect(await storedUsageType()).toBe(KeyUsageType.TrustList);

            // A list the bundle leaves unchanged is not written, so it only
            // warns; renewals then sign it with the key chain of the bundle.
            const unchanged = await plan(
                listBundle({}, KeyUsageType.Attestation),
            );
            expect(unchanged.applicable, JSON.stringify(unchanged)).toBe(true);
            expect(keyChainItem(unchanged)).toMatchObject({ action: "update" });
            expect(listItem(unchanged)).toMatchObject({
                action: "unchanged",
                issues: [
                    expect.objectContaining({
                        severity: "warning",
                        code: "KEY_CHAIN_USAGE_MISMATCH",
                    }),
                ],
            });

            // Giving it back in the same bundle lets the change apply.
            await importKeyChain(ctx.app, token, {
                id: keyChainId,
                key,
                usageType: KeyUsageType.Attestation,
            });
            const givenBack = listBundle(
                { description: "Changed by a bundle" },
                KeyUsageType.TrustList,
            );
            const planned = await plan(givenBack);
            expect(planned.applicable, JSON.stringify(planned)).toBe(true);
            expect(listItem(planned)).toMatchObject({
                action: "update",
                issues: [],
            });
            await importBundle(givenBack, planned, 201);
            expect(await storedUsageType()).toBe(KeyUsageType.TrustList);
            expect(await storedList()).toMatchObject({
                description: "Changed by a bundle",
                keyChainId,
                sequenceNumber: 2,
            });

            // A key chain document that create mode skips does not take the
            // stored trustList usage away.
            const newListId = "bundle-trust-list-new";
            const skipped = await plan(
                listBundle({ keyChainId }, KeyUsageType.Attestation, newListId),
                "create",
            );
            expect(skipped.applicable, JSON.stringify(skipped)).toBe(true);
            expect(keyChainItem(skipped)).toMatchObject({ action: "skip" });
            expect(listItem(skipped, newListId)).toMatchObject({
                action: "create",
                issues: [],
            });

            // Without a key chain document, the stored trustList usage of the
            // kept key chain lets a change apply.
            const kept = listBundle({ description: "Changed again" });
            const keptPlan = await plan(kept);
            expect(listItem(keptPlan)).toMatchObject({
                action: "update",
                issues: [],
            });
            await importBundle(kept, keptPlan, 201);
            expect(await storedList()).toMatchObject({
                description: "Changed again",
                keyChainId,
                sequenceNumber: 3,
            });
        });
    });

    describe("Entity info per ETSI TS 119 602", () => {
        const tenant = "trust-list-etsi-entity-info";
        const keyChainId = randomUUID();
        let auth: string;

        const body = (id: string, info: Record<string, unknown>) =>
            ({
                id,
                keyChainId,
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: {
                            name: "Example Provider",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                            ...info,
                        },
                    },
                ],
            }) as TrustListCreateDto;
        const create = (id: string, info: Record<string, unknown>) =>
            request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", auth)
                .send(body(id, info));
        const plan = async (bundle: ConfigBundle): Promise<ConfigImportPlan> =>
            (
                await request(ctx.app.getHttpServer())
                    .post("/config-bundles/plan?mode=upsert")
                    .set("Authorization", auth)
                    .send(bundle)
                    .expect(201)
            ).body;
        const listBundle = (id: string, info: Record<string, unknown>) =>
            documentsBundle(tenant, [
                {
                    kind: "TrustList",
                    id,
                    path: `trust-lists/${id}.json`,
                    spec: body(id, info) as unknown as Record<string, unknown>,
                },
            ]);

        beforeAll(async () => {
            const token = await getTenantAdminToken(
                ctx.app,
                ctx.clientId,
                ctx.clientSecret,
                tenant,
                [Role.Issuances, Role.Keys],
            );
            auth = `Bearer ${token}`;
            await importEntityKeyChains(ctx.app, token, ctx.configFolder);
            await importKeyChain(ctx.app, token, {
                id: keyChainId,
                key: await newPrivateKey(),
                usageType: KeyUsageType.TrustList,
            });
        });

        test.each([
            ["country", "de"],
            ["country", "Germany"],
            ["country", "GB"],
            ["lang", "EN"],
            ["lang", "en_US"],
            ["uri", "example.com"],
            ["uri", "https://example.com/a b"],
            ["contactUri", undefined],
            ["contactUri", "https://example.com/contact"],
            ["contactUri", "info"],
            ["website", undefined],
            ["website", "example.com"],
            ["website", "ftp://example.com/"],
            ["website", "HTTPS://example.com/"],
            ["phone", "030 1234567"],
        ])("refuses info.%s %j at its field", async (field, value) => {
            const response = await create(`etsi-${field}`, {
                [field]: value,
            }).expect(400);

            expect(response.body.errors).toEqual([
                expect.objectContaining({
                    path: ["entities", 0, "info", field],
                }),
            ]);
        });

        test("publishes conforming info and date-times in whole seconds", async () => {
            await create("etsi-conforming", {
                country: "EL",
                lang: "de-at",
                uri: "https://example.com/about",
                phone: "+30-21-1234567",
            }).expect(201);

            const stored = await request(ctx.app.getHttpServer())
                .get("/trust-list/etsi-conforming")
                .set("Authorization", auth)
                .expect(200);
            const { LoTE } = decodeJwt<{
                LoTE: {
                    ListAndSchemeInformation: {
                        ListIssueDateTime: string;
                        NextUpdate: string;
                    };
                    TrustedEntitiesList: Array<{
                        TrustedEntityInformation: {
                            TEAddress: {
                                TEPostalAddress: Array<{
                                    Country: string;
                                    lang: string;
                                }>;
                                TEElectronicAddress: Array<{
                                    lang: string;
                                    uriValue: string;
                                }>;
                            };
                            TEName: Array<{ lang: string }>;
                            TEInformationURI: Array<{ lang: string }>;
                        };
                    }>;
                };
            }>(stored.body.jwt);
            const seconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
            expect(LoTE.ListAndSchemeInformation.ListIssueDateTime).toMatch(
                seconds,
            );
            expect(LoTE.ListAndSchemeInformation.NextUpdate).toMatch(seconds);
            const info = LoTE.TrustedEntitiesList[0].TrustedEntityInformation;
            expect(info.TEAddress.TEPostalAddress[0].Country).toBe("EL");
            // Published in the entity's language and, as ETSI TS 119 602
            // clause 6.1.4 requires, in en with the same text.
            expect(info.TEName.map((name) => name.lang)).toEqual([
                "de-at",
                "en",
            ]);
            // The postal address carries the full tag, not only "de".
            expect(
                info.TEAddress.TEPostalAddress.map((address) => address.lang),
            ).toEqual(["de-at", "en"]);
            // Clause 6.5.3.2: e-mail as mailto: URI and web site per
            // language (6.1.4), then the telephone number.
            expect(info.TEAddress.TEElectronicAddress).toEqual([
                { lang: "de-at", uriValue: "mailto:info@example.com" },
                { lang: "de-at", uriValue: "https://example.com/" },
                { lang: "en", uriValue: "mailto:info@example.com" },
                { lang: "en", uriValue: "https://example.com/" },
                { lang: "de-at", uriValue: "tel:+30-21-1234567" },
                { lang: "en", uriValue: "tel:+30-21-1234567" },
            ]);
            expect(info.TEInformationURI.map((uri) => uri.lang)).toEqual([
                "de-at",
                "en",
            ]);
        });

        test.each([
            ["country", "Germany", TRUST_LIST_COUNTRY_MESSAGE],
            ["lang", "EN", TRUST_LIST_LANGUAGE_MESSAGE],
            ["uri", "https://example.com/a b", TRUST_LIST_URI_MESSAGE],
            ["contactUri", "info", TRUST_LIST_EMAIL_MESSAGE],
            ["website", "ftp://example.com/", TRUST_LIST_WEBSITE_MESSAGE],
            ["phone", "030 1234567", TRUST_LIST_PHONE_MESSAGE],
        ])("the plan blocks info.%s %j", async (field, value, message) => {
            const planned = await plan(
                listBundle(`etsi-plan-${field}`, { [field]: value }),
            );

            expect(planned.applicable).toBe(false);
            expect(
                planned.items.find((item) => item.kind === "TrustList")?.issues,
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        severity: "error",
                        code: "CURRENT_SCHEMA_VALIDATION_FAILED",
                        path: `/spec/entities/0/info/${field}`,
                        message,
                    }),
                ]),
            );
        });

        test("the plan asks for the web site a 9.x file cannot carry", async () => {
            const bundle = listBundle("etsi-plan-v1", {});
            const document = bundle.documents[0];
            document.$schema = schemaUrl("TrustList", 1);
            const info = (
                document.spec.entities as Array<{
                    info: Record<string, unknown>;
                }>
            )[0].info;
            delete info.website;
            bundle.manifest.resources[0].$schema = document.$schema;
            bundle.manifest.resources[0].sha256 = createHash("sha256")
                .update(JSON.stringify(document))
                .digest("hex");

            const planned = await plan(bundle);

            expect(planned.applicable).toBe(false);
            const item = planned.items.find(
                (entry) => entry.kind === "TrustList",
            );
            expect(item?.issues).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        severity: "required-input",
                        code: "TRUST_LIST_WEBSITE_MISSING",
                        path: "/spec/entities/0/info/website",
                    }),
                ]),
            );
            expect(item?.migrations ?? []).toEqual([]);
        });
    });

    describe("Deleting a referenced trust list", () => {
        const listId = "referenced-trust-list";
        const credentialConfigId = "references-trust-list";

        const presentationConfig = (id: string, ref: object) => ({
            id,
            description: `References ${listId}`,
            dcql_query: {
                credentials: [
                    {
                        id: "pid",
                        format: "dc+sd-jwt",
                        meta: { vct_values: ["urn:eudi:pid:de:1"] },
                        claims: [{ path: ["given_name"] }],
                        trusted_authorities: [
                            { type: "etsi_tl", values: [ref] },
                        ],
                    },
                ],
            },
        });

        beforeAll(async () => {
            const server = ctx.app.getHttpServer();
            const auth = `Bearer ${ctx.authToken}`;
            await request(server)
                .post("/trust-list")
                .set("Authorization", auth)
                .send({
                    id: listId,
                    keyChainId: "570852d7-7e7f-40af-a0e3-a6ebffd75ed0",
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId:
                                "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                            revocationKeyChainId:
                                "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                            info: {
                                name: "Referenced Provider",
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                            },
                        },
                    ],
                } satisfies TrustListCreateDto)
                .expect(201);
            await request(server)
                .post("/verifier/config")
                .set("Authorization", auth)
                .send(presentationConfig("by-id", { trustListId: listId }))
                .expect(201);
            await request(server)
                .post("/verifier/config")
                .set("Authorization", auth)
                .send(
                    presentationConfig("by-url", {
                        url: `<TENANT_URL>/trust-list/${listId}`,
                    }),
                )
                .expect(201);
            // A list whose ID only starts with the ID is another list.
            await request(server)
                .post("/verifier/config")
                .set("Authorization", auth)
                .send(
                    presentationConfig("other-list", {
                        trustListId: `${listId}-old`,
                    }),
                )
                .expect(201);
            const credentialConfig = readConfig<Record<string, unknown>>(
                join(
                    ctx.configFolder,
                    "haip/issuance/credentials/pid-no-key.json",
                ),
            );
            await request(server)
                .post("/issuer/credentials")
                .set("Authorization", auth)
                .send({
                    ...credentialConfig,
                    id: credentialConfigId,
                    schemaMeta: {
                        version: "1.0.0",
                        attestationLoS: "iso_18045_high",
                        bindingType: "key",
                        trustedAuthorities: [
                            {
                                frameworkType: "etsi_tl",
                                value: `http://localhost:3000/issuers/root/trust-list/${listId}`,
                            },
                        ],
                    },
                })
                .expect(201);
            await request(server)
                .post("/issuer/config")
                .set("Authorization", auth)
                .send({
                    authorizationServers: [
                        { id: "issuer-built-in", type: "built-in" },
                    ],
                    walletProviderTrustLists: [{ trustListId: listId }],
                })
                .expect(201);
        });

        test("refuses with 409 and names the configurations", async () => {
            const response = await request(ctx.app.getHttpServer())
                .delete(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(409);

            expect(response.body.code).toBe("TRUST_LIST_IN_USE");
            expect(response.body.message).toBe(
                `Trust list "${listId}" is still referenced by 2 presentation configs ("by-id" and "by-url"), 1 credential config ("${credentialConfigId}") and the issuance configuration (wallet provider trust lists). Remove these references before deleting the trust list.`,
            );
            expect(response.body.references).toHaveLength(4);
            expect(response.body.references).toEqual(
                expect.arrayContaining([
                    {
                        kind: "PresentationConfig",
                        id: "by-id",
                        description: `References ${listId}`,
                    },
                    {
                        kind: "PresentationConfig",
                        id: "by-url",
                        description: `References ${listId}`,
                    },
                    {
                        kind: "CredentialConfig",
                        id: credentialConfigId,
                        description: "Personal ID",
                    },
                    { kind: "IssuanceConfig" },
                ]),
            );

            await request(ctx.app.getHttpServer())
                .get(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(200);
        });

        /** Token of a new client of the root tenant with only `roles`. */
        async function clientToken(clientId: string, roles: string[]) {
            const server = ctx.app.getHttpServer();
            const created = await request(server)
                .post("/client")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({ clientId, roles })
                .expect(201);
            const token = await request(server)
                .post("/api/oauth2/token")
                .send({
                    grant_type: "client_credentials",
                    client_id: clientId,
                    client_secret: created.body.clientSecret,
                })
                .expect(201);
            return token.body.access_token as string;
        }

        test("names presentation configs for presentation:request", async () => {
            const token = await clientToken("trust-list-issuer-requester", [
                "issuance:manage",
                "presentation:request",
            ]);

            const response = await request(ctx.app.getHttpServer())
                .delete(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${token}`)
                .expect(409);

            expect(response.body.message).toContain(
                '2 presentation configs ("by-id" and "by-url")',
            );
        });

        test("hides presentation configs from a caller with only issuance:manage", async () => {
            const token = await clientToken("trust-list-issuer-admin", [
                "issuance:manage",
            ]);

            const response = await request(ctx.app.getHttpServer())
                .delete(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${token}`)
                .expect(409);

            expect(response.body.message).toBe(
                `Trust list "${listId}" is still referenced by 2 presentation configs (presentation:manage or presentation:request shows which), 1 credential config ("${credentialConfigId}") and the issuance configuration (wallet provider trust lists). Remove these references before deleting the trust list.`,
            );
            expect(JSON.stringify(response.body)).not.toContain('"by-id"');
            expect(JSON.stringify(response.body)).not.toContain('"by-url"');
        });

        test("counts, but does not name, configurations the caller may not read", async () => {
            const server = ctx.app.getHttpServer();
            const token = await clientToken("trust-list-verifier-admin", [
                "presentation:manage",
            ]);

            const response = await request(server)
                .delete(`/trust-list/${listId}`)
                .set("Authorization", `Bearer ${token}`)
                .expect(409);

            expect(response.body.message).toBe(
                `Trust list "${listId}" is still referenced by 2 presentation configs ("by-id" and "by-url"), 1 credential config (issuance:manage shows which) and the issuance configuration (wallet provider trust lists). Remove these references before deleting the trust list.`,
            );
            expect(response.body.references).toEqual(
                expect.arrayContaining([
                    { kind: "CredentialConfig" },
                    { kind: "IssuanceConfig" },
                ]),
            );
            expect(JSON.stringify(response.body)).not.toContain(
                credentialConfigId,
            );
        });

        test("keeps refusing while one reference is left", async () => {
            const server = ctx.app.getHttpServer();
            const auth = `Bearer ${ctx.authToken}`;
            for (const id of ["by-id", "by-url"]) {
                await request(server)
                    .delete(`/verifier/config/${id}`)
                    .set("Authorization", auth)
                    .expect(204);
            }
            await request(server)
                .delete(`/issuer/credentials/${credentialConfigId}`)
                .set("Authorization", auth)
                .expect(204);

            const response = await request(server)
                .delete(`/trust-list/${listId}`)
                .set("Authorization", auth)
                .expect(409);

            expect(response.body.references).toEqual([
                { kind: "IssuanceConfig" },
            ]);
        });

        test("deletes the list once no configuration of its tenant references it", async () => {
            const server = ctx.app.getHttpServer();
            const auth = `Bearer ${ctx.authToken}`;
            // A config of another tenant naming the same ID is about that tenant's list.
            const otherTenantToken = await getToken(
                ctx.app,
                ctx.clientId,
                ctx.clientSecret,
                "trust-list-other-tenant",
            );
            const otherAuth = `Bearer ${otherTenantToken}`;
            await request(server)
                .post("/verifier/config")
                .set("Authorization", otherAuth)
                .send(presentationConfig("by-id", { trustListId: listId }))
                .expect(201);
            const { keyChainId: _rootKey, ...credentialConfig } = readConfig<
                Record<string, unknown>
            >(
                join(
                    ctx.configFolder,
                    "haip/issuance/credentials/pid-no-key.json",
                ),
            );
            await request(server)
                .post("/issuer/credentials")
                .set("Authorization", otherAuth)
                .send({
                    ...credentialConfig,
                    id: credentialConfigId,
                    schemaMeta: {
                        version: "1.0.0",
                        attestationLoS: "iso_18045_high",
                        bindingType: "key",
                        trustedAuthorities: [{ trustListId: listId }],
                    },
                })
                .expect(201);
            await request(server)
                .post("/issuer/config")
                .set("Authorization", otherAuth)
                .send({
                    authorizationServers: [
                        { id: "issuer-built-in", type: "built-in" },
                    ],
                    walletProviderTrustLists: [{ trustListId: listId }],
                })
                .expect(201);
            await request(server)
                .post("/issuer/config")
                .set("Authorization", auth)
                .send({
                    authorizationServers: [
                        { id: "issuer-built-in", type: "built-in" },
                    ],
                    walletProviderTrustLists: [],
                })
                .expect(201);

            await request(server)
                .delete(`/trust-list/${listId}`)
                .set("Authorization", auth)
                .expect(204);
            await request(server)
                .get(`/trust-list/${listId}`)
                .set("Authorization", auth)
                .expect(404);
        });

        test("answers 204 for an unknown trust list, even one a config names", async () => {
            const server = ctx.app.getHttpServer();
            const auth = `Bearer ${ctx.authToken}`;
            await request(server)
                .post("/verifier/config")
                .set("Authorization", auth)
                .send(
                    presentationConfig("names-unknown-list", {
                        trustListId: "never-created",
                    }),
                )
                .expect(201);

            const response = await request(server)
                .delete("/trust-list/never-created")
                .set("Authorization", auth);

            expect(response.status).toBe(204);
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
                            contactUri: "info@example.com",
                            website: "https://example.com/",
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

    describe("LoTE JWT Signing with an ES384 key chain", () => {
        test("signs the LoTE with ES384 and verifies against its x5c", async () => {
            const keyChainId = await createKeyChain(ctx.app, ctx.authToken, {
                usageType: KeyUsageType.TrustList,
                alg: "ES384",
            });
            const createDto: TrustListCreateDto = {
                id: "es384-trust-list",
                description: "ES384 Signing Test",
                keyChainId,
                entities: [
                    {
                        type: "internal",
                        issuerKeyChainId:
                            "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                        revocationKeyChainId:
                            "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                        info: {
                            name: "ES384 Test Provider",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                            lang: "en",
                        },
                    },
                ],
            };

            try {
                const response = await request(ctx.app.getHttpServer())
                    .post("/trust-list")
                    .set("Authorization", `Bearer ${ctx.authToken}`)
                    .send(createDto)
                    .expect(201);

                const payload = await expectJwsSignedWithX5c(
                    response.body.jwt,
                    "ES384",
                );
                expect(payload.LoTE).toBeDefined();
            } finally {
                // Later tests rely on the default trust list key chain.
                await request(ctx.app.getHttpServer())
                    .delete(`/trust-list/${createDto.id}`)
                    .set("Authorization", `Bearer ${ctx.authToken}`)
                    .expect((res) => expect([204, 404]).toContain(res.status));
                await deleteKeyChain(ctx.app, ctx.authToken, keyChainId);
            }
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
                        info: {
                            name: "Provider 1",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                            lang: "en",
                        },
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
                        info: {
                            name: "Public URL Provider",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                            lang: "en",
                        },
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
                            info: {
                                name: "Renewal Provider",
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                                lang: "en",
                            },
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
                // Whole seconds, as ETSI TS 119 602 clause 6.1.3 requires.
                NextUpdate: new Date(later.getTime() + 30 * 24 * 60 * 60 * 1000)
                    .toISOString()
                    .replace(/\.\d{3}Z$/, "Z"),
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

        test("refuses a key chain id that does not exist at keyChainId", async () => {
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
                        info: {
                            name: "Test Provider",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                            lang: "en",
                        },
                    },
                ],
            };

            const res = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(400);
            expect(res.body.errors).toEqual([
                {
                    path: ["keyChainId"],
                    code: "key_chain_not_found",
                    message:
                        'Key chain "non-existent-key-chain" does not exist.',
                },
            ]);
        });

        test("refuses a key chain that lacks TrustList usage at keyChainId", async () => {
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
                        info: {
                            name: "Test Provider",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                            lang: "en",
                        },
                    },
                ],
            };

            const res = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(400);
            expect(res.body.errors).toEqual([
                {
                    path: ["keyChainId"],
                    code: "key_chain_usage_mismatch",
                    message:
                        "Key chain c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad is not valid for Trust List usage (key lacks TrustList usage)",
                },
            ]);
        });

        test("should reject a trust list without keyChainId on a tenant without trust list key chain", async () => {
            const token = await getToken(
                ctx.app,
                ctx.clientId,
                ctx.clientSecret,
                "trust-list-without-key-chain",
            );
            await importEntityKeyChains(ctx.app, token, ctx.configFolder);

            const response = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${token}`)
                .send({
                    id: "no-key-chain-test",
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId:
                                "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                            revocationKeyChainId:
                                "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                            info: {
                                name: "Test Provider",
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                            },
                        },
                    ],
                } satisfies TrustListCreateDto)
                .expect(409);

            expect(response.body.message).toBe(
                "No key chain found with usage type 'trustList' for tenant trust-list-without-key-chain. Create a key chain with usage type \"trustList\" or name one in keyChainId.",
            );
            await request(ctx.app.getHttpServer())
                .get("/trust-list/no-key-chain-test")
                .set("Authorization", `Bearer ${token}`)
                .expect(404);
        });

        test("refuses external entities with invalid PEM certificates at their fields", async () => {
            const createDto: TrustListCreateDto = {
                id: "invalid-pem-test",
                description: "Invalid PEM Test",
                entities: [
                    {
                        type: "external",
                        issuerCertPem: "not-a-valid-pem",
                        revocationCertPem: "also-not-valid",
                        info: {
                            name: "Invalid Provider",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                        },
                    },
                ],
            };

            const res = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(createDto)
                .expect(400);
            expect(res.body.errors).toEqual(
                ["issuerCertPem", "revocationCertPem"].map((field) => ({
                    path: ["entities", 0, field],
                    code: "invalid_certificate",
                    message: `${field} must be an X.509 certificate in PEM or Base64 DER.`,
                })),
            );
        });

        test("refuses country and uri with the body schema codes, each at its field", async () => {
            const res = await request(ctx.app.getHttpServer())
                .post("/trust-list")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    id: "invalid-info-test",
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId:
                                "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                            revocationKeyChainId:
                                "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                            info: {
                                name: "Test Provider",
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                                country: "Germany",
                                uri: "issuer.example",
                            },
                        },
                    ],
                })
                .expect(400);
            expect(
                res.body.errors.map(
                    (issue: { path: unknown[]; code: string }) => [
                        issue.path.join("."),
                        issue.code,
                    ],
                ),
            ).toEqual([
                // The body schema refuses both (ETSI TS 119 602).
                ["entities.0.info.uri", "invalid_format"],
                ["entities.0.info.country", "invalid_value"],
            ]);
        });

        test.each([
            ["get", "/trust-list/does-not-exist"],
            ["get", "/trust-list/does-not-exist/export"],
            ["get", "/trust-list/does-not-exist/versions"],
            ["get", "/trust-list/does-not-exist/versions/does-not-exist"],
        ] as const)("answers 404 for %s %s", async (method, path) => {
            await request(ctx.app.getHttpServer())
                [method](path)
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .expect(404);
        });

        test("answers 404 when updating a trust list that does not exist", async () => {
            const res = await request(ctx.app.getHttpServer())
                .put("/trust-list/does-not-exist")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send({
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId:
                                "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad",
                            revocationKeyChainId:
                                "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746",
                            info: {
                                name: "Test Provider",
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                            },
                        },
                    ],
                })
                .expect(404);
            expect(res.body.message).toBe("Trust list not found");
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
                        info: {
                            name: "Public Access Provider",
                            contactUri: "info@example.com",
                            website: "https://example.com/",
                            lang: "en",
                        },
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
