import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Role } from "../src/auth/roles/role.enum.js";
import { ResponseType } from "../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { PresentationConfigCreateDto } from "../src/verifier/presentations/dto/presentation-config-create.dto.js";
import {
    IssuanceTestContext,
    readConfig,
    setupIssuanceTestApp,
} from "./utils.js";

describe("Client Resource-Level Access Control (e2e)", () => {
    let ctx: IssuanceTestContext;
    let adminToken: string;
    let restrictedClientToken: string;
    let restrictedClientSecret: string;
    let unrestrictedClientToken: string;

    beforeAll(async () => {
        // Use the shared test setup that creates tenant, keys, certs, and configs
        ctx = await setupIssuanceTestApp({ exceptionFilter: true });
        adminToken = ctx.authToken;

        // Add some presentation configs that are needed for the tests
        const configFolder = resolve(__dirname + "/fixtures");

        // Import presentation configs
        await request(ctx.app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${adminToken}`)
            .send(
                readConfig<PresentationConfigCreateDto>(
                    join(configFolder, "haip/presentation/pid-no-hook.json"),
                ),
            )
            .expect(201);

        await request(ctx.app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${adminToken}`)
            .send(
                readConfig<PresentationConfigCreateDto>(
                    join(configFolder, "haip/presentation/pid.json"),
                ),
            )
            .expect(201);

        // Create restricted client (can only use specific configs)
        await createRestrictedClient(ctx.app);

        // Create unrestricted client (can use all configs)
        await createUnrestrictedClient(ctx.app);
    });

    afterAll(async () => {
        await ctx?.app?.close();
    });

    async function createRestrictedClient(app: INestApplication<App>) {
        // Create a client that can only use specific configs
        const client = await request(app.getHttpServer())
            .post("/client")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                clientId: "restricted-client",
                roles: [Role.PresentationRequest, Role.IssuanceOffer],
                allowedPresentationConfigs: ["pid-no-hook"], // Can only use pid-no-hook
                allowedIssuanceConfigs: ["pid-no-key"], // Can only use pid
            })
            .then((res) => res.body);

        restrictedClientSecret = client.clientSecret;
        const restrictedTokenRes = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                client_id: client.clientId,
                client_secret: client.clientSecret,
                grant_type: "client_credentials",
            })
            .expect(201);

        restrictedClientToken = restrictedTokenRes.body.access_token;
    }

    async function createUnrestrictedClient(app: INestApplication<App>) {
        // Create a client without config restrictions
        const client = await request(app.getHttpServer())
            .post("/client")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({
                clientId: "unrestricted-client",
                roles: [Role.PresentationRequest, Role.IssuanceOffer],
                // No allowedPresentationConfigs or allowedIssuanceConfigs
            })
            .then((res) => res.body);

        const unrestrictedTokenRes = await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                client_id: client.clientId,
                client_secret: client.clientSecret,
                grant_type: "client_credentials",
            })
            .expect(201);

        unrestrictedClientToken = unrestrictedTokenRes.body.access_token;
    }

    describe("Presentation Request Authorization", () => {
        test("restricted client can create offer for allowed presentation config", async () => {
            const res = await request(ctx.app.getHttpServer())
                .post("/verifier/offer")
                .set("Authorization", `Bearer ${restrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid-no-hook", // This is in allowedPresentationConfigs
                });

            expect(res.status).toBe(201);
            expect(res.body.uri).toBeDefined();
        });

        test("restricted client cannot create offer for disallowed presentation config", async () => {
            const res = await request(ctx.app.getHttpServer())
                .post("/verifier/offer")
                .set("Authorization", `Bearer ${restrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid-no-key", // This is NOT in allowedPresentationConfigs
                });

            expect(res.status).toBe(403);
            expect(res.body.message).toContain(
                "Client is not authorized to use presentation config",
            );
        });

        test("unrestricted client can create offer for any presentation config", async () => {
            // Test with pid-no-hook
            const res1 = await request(ctx.app.getHttpServer())
                .post("/verifier/offer")
                .set("Authorization", `Bearer ${unrestrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid-no-hook",
                });

            expect(res1.status).toBe(201);

            // Test with pid
            const res2 = await request(ctx.app.getHttpServer())
                .post("/verifier/offer")
                .set("Authorization", `Bearer ${unrestrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid",
                });

            expect(res2.status).toBe(201);
        });
    });

    describe("Issuance Offer Authorization", () => {
        test("restricted client can create offer for allowed issuance config", async () => {
            const res = await request(ctx.app.getHttpServer())
                .post("/issuer/offer")
                .set("Authorization", `Bearer ${restrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: ["pid-no-key"], // This is in allowedIssuanceConfigs
                    flow: "pre_authorized_code",
                });

            expect(res.status).toBe(201);
        });

        test("restricted client cannot create offer for disallowed issuance config", async () => {
            const res = await request(ctx.app.getHttpServer())
                .post("/issuer/offer")
                .set("Authorization", `Bearer ${restrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: ["citizen"], // This is NOT in allowedIssuanceConfigs
                    flow: "pre_authorized_code",
                });

            expect(res.status).toBe(403);
            expect(res.body.message).toContain(
                "Client is not authorized to use issuance config",
            );
        });

        test("restricted client cannot create offer if any config is disallowed", async () => {
            const res = await request(ctx.app.getHttpServer())
                .post("/issuer/offer")
                .set("Authorization", `Bearer ${restrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: ["pid-no-key", "citizen"], // citizen is not allowed
                    flow: "pre_authorized_code",
                });

            expect(res.status).toBe(403);
            expect(res.body.message).toContain("citizen");
        });

        test("unrestricted client can create offer for any issuance config", async () => {
            // Test with pid
            const res1 = await request(ctx.app.getHttpServer())
                .post("/issuer/offer")
                .set("Authorization", `Bearer ${unrestrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                });

            expect(res1.status).toBe(201);

            // Test with citizen
            const res2 = await request(ctx.app.getHttpServer())
                .post("/issuer/offer")
                .set("Authorization", `Bearer ${unrestrictedClientToken}`)
                .send({
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: ["citizen"],
                    flow: "pre_authorized_code",
                });

            expect(res2.status).toBe(201);
        });
    });

    describe("Session Access", () => {
        const get = (path: string, token: string) =>
            request(ctx.app.getHttpServer())
                .get(path)
                .set("Authorization", `Bearer ${token}`);
        const post = (path: string, token: string, body: object = {}) =>
            request(ctx.app.getHttpServer())
                .post(path)
                .set("Authorization", `Bearer ${token}`)
                .send(body);
        const presentation = (token: string, requestId: string) =>
            post("/verifier/offer", token, {
                response_type: ResponseType.URI,
                requestId,
            })
                .expect(201)
                .then((res) => res.body.session as string);
        const issuance = (token: string, id: string) =>
            post("/issuer/offer", token, {
                response_type: ResponseType.URI,
                credentialConfigurationIds: [id],
                flow: "pre_authorized_code",
            })
                .expect(201)
                .then((res) => res.body.session as string);

        let allowed: string[];
        let other: string[];

        beforeAll(async () => {
            allowed = [
                await presentation(restrictedClientToken, "pid-no-hook"),
                await issuance(restrictedClientToken, "pid-no-key"),
            ];
            other = [
                await presentation(unrestrictedClientToken, "pid"),
                await issuance(unrestrictedClientToken, "citizen"),
            ];
        });

        test("restricted client lists and counts only sessions of its allowed configs", async () => {
            const list = await get(
                "/session?pageSize=100",
                restrictedClientToken,
            ).expect(200);
            const ids = list.body.items.map((item: { id: string }) => item.id);
            expect(ids).toEqual(expect.arrayContaining(allowed));
            for (const id of other) expect(ids).not.toContain(id);

            const stats = await get(
                "/session/stats",
                restrictedClientToken,
            ).expect(200);
            expect(
                stats.body.presentation.total + stats.body.issuance.total,
            ).toBe(list.body.total);
        });

        test("restricted client reads, cancels and deletes no session of another config", async () => {
            for (const id of other) {
                await get(`/session/${id}`, restrictedClientToken).expect(404);
                await get(`/session/${id}/logs`, restrictedClientToken).expect(
                    404,
                );
                await get(
                    `/session/${id}/events`,
                    restrictedClientToken,
                ).expect(404);
                await get(
                    `/session/${id}/credential-status`,
                    restrictedClientToken,
                ).expect(404);
                await post(
                    `/session/${id}/cancel`,
                    restrictedClientToken,
                ).expect(404);
                await request(ctx.app.getHttpServer())
                    .delete(`/session/${id}`)
                    .set("Authorization", `Bearer ${restrictedClientToken}`)
                    .expect(204);
                // Still there, and still open.
                const session = await get(
                    `/session/${id}`,
                    unrestrictedClientToken,
                ).expect(200);
                expect(session.body.status).toBe("active");
            }
        });

        test("restricted client reads the sessions of its allowed configs", async () => {
            for (const id of allowed) {
                await get(`/session/${id}`, restrictedClientToken).expect(200);
                await get(`/session/${id}/logs`, restrictedClientToken).expect(
                    200,
                );
            }
            await get(
                `/session/${allowed[1]}/credential-status`,
                restrictedClientToken,
            ).expect(200);
        });

        test("restricted client cancels and deletes the sessions of its allowed configs", async () => {
            const cancelled = await presentation(
                restrictedClientToken,
                "pid-no-hook",
            );
            await post(
                `/session/${cancelled}/cancel`,
                restrictedClientToken,
            ).expect(204);
            const session = await get(
                `/session/${cancelled}`,
                restrictedClientToken,
            ).expect(200);
            expect(session.body.status).toBe("cancelled");

            const deleted = await issuance(restrictedClientToken, "pid-no-key");
            await request(ctx.app.getHttpServer())
                .delete(`/session/${deleted}`)
                .set("Authorization", `Bearer ${restrictedClientToken}`)
                .expect(204);
            await get(`/session/${deleted}`, unrestrictedClientToken).expect(
                404,
            );
        });

        test("unrestricted client sees the sessions of all configs", async () => {
            const list = await get(
                "/session?pageSize=100",
                unrestrictedClientToken,
            ).expect(200);
            expect(
                list.body.items.map((item: { id: string }) => item.id),
            ).toEqual(expect.arrayContaining([...allowed, ...other]));
        });
    });

    describe("Client Management", () => {
        test("client entity includes allowed config fields", async () => {
            const res = await request(ctx.app.getHttpServer())
                .get("/client/restricted-client")
                .set("Authorization", `Bearer ${adminToken}`)
                .expect(200);

            expect(res.body.allowedPresentationConfigs).toEqual([
                "pid-no-hook",
            ]);
            expect(res.body.allowedIssuanceConfigs).toEqual(["pid-no-key"]);
        });

        test("can update client allowed configs", async () => {
            // Update the restricted client to allow different configs
            await request(ctx.app.getHttpServer())
                .patch("/client/restricted-client")
                .set("Authorization", `Bearer ${adminToken}`)
                .send({
                    roles: [Role.PresentationRequest, Role.IssuanceOffer],
                    allowedPresentationConfigs: ["pid", "pid-no-hook"], // Add pid
                    allowedIssuanceConfigs: ["pid-no-key", "citizen"], // Add citizen
                })
                .expect(200);

            const newTokenRes = await request(ctx.app.getHttpServer())
                .post("/api/oauth2/token")
                .send({
                    client_id: "restricted-client",
                    client_secret: restrictedClientSecret,
                    grant_type: "client_credentials",
                })
                .expect(201);

            const newToken = newTokenRes.body.access_token;

            // Now the client should be able to use pid presentation config
            const presRes = await request(ctx.app.getHttpServer())
                .post("/verifier/offer")
                .set("Authorization", `Bearer ${newToken}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid",
                });

            expect(presRes.status).toBe(201);

            // And citizen issuance config
            const issRes = await request(ctx.app.getHttpServer())
                .post("/issuer/offer")
                .set("Authorization", `Bearer ${newToken}`)
                .send({
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: ["citizen"],
                    flow: "pre_authorized_code",
                });

            expect(issRes.status).toBe(201);
        });

        test("empty allowed configs array means all configs are allowed", async () => {
            // Create client with empty arrays
            const client = await request(ctx.app.getHttpServer())
                .post("/client")
                .set("Authorization", `Bearer ${adminToken}`)
                .send({
                    clientId: "empty-arrays-client",
                    roles: [Role.PresentationRequest, Role.IssuanceOffer],
                    allowedPresentationConfigs: [], // Empty = all allowed
                    allowedIssuanceConfigs: [], // Empty = all allowed
                })
                .then((res) => res.body);

            const tokenRes = await request(ctx.app.getHttpServer())
                .post("/api/oauth2/token")
                .send({
                    client_id: client.clientId,
                    client_secret: client.clientSecret,
                    grant_type: "client_credentials",
                })
                .expect(201);

            const token = tokenRes.body.access_token;

            // Should be able to use any presentation config
            const presRes = await request(ctx.app.getHttpServer())
                .post("/verifier/offer")
                .set("Authorization", `Bearer ${token}`)
                .send({
                    response_type: ResponseType.URI,
                    requestId: "pid",
                });

            expect(presRes.status).toBe(201);
        });
    });
});
