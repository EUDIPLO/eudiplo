import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { IssuanceTestContext, setupIssuanceTestApp } from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Issuance - Configuration", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    const chainedAuthorizationServer = {
        id: "chained-auth",
        type: "chained",
        enabled: true,
        upstream: {
            issuer: "https://auth.example.com/realms/test",
            clientId: "test-client",
            clientSecret: "test-secret",
        },
    };

    async function ensureBaselineConfig() {
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                batchSize: 1,
                authorizationServers: [chainedAuthorizationServer],
            })
            .expect(201);
    }

    test("get should create a default issuance config when none exists", async () => {
        const res = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(res.body.authorizationServers).toBeDefined();
        expect(res.body.authorizationServers).toHaveLength(1);
        expect(res.body.authorizationServers[0]).toMatchObject({
            type: "built-in",
        });
    });

    test("partial update should preserve existing config values", async () => {
        // Step 1: Ensure a valid baseline configuration exists
        await ensureBaselineConfig();

        // Step 2: Get the current configuration
        const initialRes = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const initialConfig = initialRes.body;
        expect(initialConfig.dPopRequired).toBeDefined();
        expect(initialConfig.display).toBeDefined();

        // Step 3: Update only one field (batchSize), leaving others undefined
        const partialUpdate: Partial<IssuanceDto> = {
            batchSize: 5,
        };

        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(partialUpdate)
            .expect(201);

        // Step 4: Verify that other fields were preserved
        const updatedRes = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const updatedConfig = updatedRes.body;

        // The updated field should have the new value
        expect(updatedConfig.batchSize).toBe(5);

        // Existing fields should be preserved (not overwritten with null/undefined)
        expect(updatedConfig.dPopRequired).toBe(initialConfig.dPopRequired);
        expect(updatedConfig.display).toEqual(initialConfig.display);
    });

    test("null authorizationServers should be rejected", async () => {
        // Step 1: Set up a configuration with a chained authorization server
        const setupConfig: Partial<IssuanceDto> = {
            batchSize: 10,
            authorizationServers: [chainedAuthorizationServer],
        };

        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(setupConfig)
            .expect(201);

        // Verify authorizationServers is set
        const setupRes = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(setupRes.body.authorizationServers).toBeDefined();
        expect(setupRes.body.authorizationServers).toHaveLength(1);
        expect(setupRes.body.authorizationServers[0].type).toBe("chained");

        // Step 2: Send an update with authorizationServers explicitly set to null
        const updateWithNull = {
            batchSize: 5,
            authorizationServers: null,
        };

        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(updateWithNull)
            .expect(400);
    });

    test("authorizationServers config should not be lost on partial update", async () => {
        // Step 1: Set up a configuration with authorizationServers
        const configWithChainedAs: Partial<IssuanceDto> = {
            batchSize: 1,
            authorizationServers: [chainedAuthorizationServer],
        };

        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(configWithChainedAs)
            .expect(201);

        // Verify authorizationServers is set
        const afterSetup = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(afterSetup.body.authorizationServers).toBeDefined();
        expect(afterSetup.body.authorizationServers).toHaveLength(1);
        expect(afterSetup.body.authorizationServers[0].type).toBe("chained");

        // Step 2: Update a different field, not mentioning authorizationServers at all
        const partialUpdate: Partial<IssuanceDto> = {
            batchSize: 2,
        };

        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(partialUpdate)
            .expect(201);

        // Step 3: Verify authorizationServers is still present
        const finalRes = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(finalRes.body.batchSize).toBe(2);
        expect(finalRes.body.authorizationServers).toBeDefined();
        expect(finalRes.body.authorizationServers[0].enabled).toBe(true);
        expect(finalRes.body.authorizationServers[0].upstream.issuer).toBe(
            "https://auth.example.com/realms/test",
        );
    });

    test("should reject creating or updating config when no authorization servers are configured", async () => {
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                batchSize: 5,
                authorizationServers: [],
            })
            .expect(400);
    });

    test("external authorization servers should accept explicit session binding config", async () => {
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                batchSize: 2,
                authorizationServers: [
                    {
                        type: "external",
                        id: "issuer-external",
                        issuer: "https://auth.example.com",
                        sessionBinding: {
                            method: "access_token_claim",
                            claim: "issuer_state",
                        },
                    },
                ],
            })
            .expect(201)
            .expect((res) => {
                expect(res.body.authorizationServers[0]).toMatchObject({
                    type: "external",
                    id: "issuer-external",
                    issuer: "https://auth.example.com",
                    sessionBinding: {
                        method: "access_token_claim",
                        claim: "issuer_state",
                    },
                });
            });
    });
    describe("request bodies are validated like configuration import", () => {
        test("a GET response can be sent back as it is", async () => {
            await ensureBaselineConfig();
            const current = await request(app.getHttpServer())
                .get("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            // tenantId, createdAt, updatedAt and nulls of unset fields included.
            expect(current.body.tenantId).toBeDefined();

            await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ ...current.body, batchSize: 3 })
                .expect(201);

            const updated = await request(app.getHttpServer())
                .get("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            expect(updated.body.batchSize).toBe(3);
            expect(updated.body.authorizationServers).toEqual(
                current.body.authorizationServers,
            );
        });

        test("unknown or misspelled fields are rejected and nothing is stored", async () => {
            await ensureBaselineConfig();
            const res = await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ batchSize: 4, dpopRequired: true })
                .expect(400);
            expect(res.body.errors).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ code: "unrecognized_keys" }),
                ]),
            );

            const stored = await request(app.getHttpServer())
                .get("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            expect(stored.body.batchSize).toBe(1);
        });

        test("null clears an optional setting", async () => {
            await ensureBaselineConfig();
            for (const txCodeMaxAttempts of [5, null]) {
                await request(app.getHttpServer())
                    .post("/issuer/config")
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({ txCodeMaxAttempts })
                    .expect(201);
            }
            const stored = await request(app.getHttpServer())
                .get("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            expect(stored.body.txCodeMaxAttempts).toBeNull();
        });

        test("credential configurations reject misspelled fields and accept a GET response", async () => {
            const configs = await request(app.getHttpServer())
                .get("/issuer/credentials")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            const existing = await request(app.getHttpServer())
                .get(`/issuer/credentials/${configs.body[0].id}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

            // A copy of a GET response is accepted: the tenant fields are dropped.
            await request(app.getHttpServer())
                .post("/issuer/credentials")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ ...existing.body, id: "validated-copy" })
                .expect(201);

            const typo = await request(app.getHttpServer())
                .post("/issuer/credentials")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    ...existing.body,
                    id: "validated-typo",
                    statusManagment: true,
                })
                .expect(400);
            expect(JSON.stringify(typo.body.errors)).toContain(
                "statusManagment",
            );

            await request(app.getHttpServer())
                .patch("/issuer/credentials/validated-copy")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ descripton: "typo" })
                .expect(400);
            await request(app.getHttpServer())
                .patch("/issuer/credentials/validated-copy")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ description: "patched" })
                .expect(200);
        });
    });
});
