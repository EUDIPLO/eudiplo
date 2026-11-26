import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import type { Repository } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
    CLIENTS_PROVIDER,
    type ClientsProvider,
} from "../../src/auth/client/client.provider.js";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { JwtService } from "../../src/auth/jwt.service.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { PresentationConfigCreateDto } from "../../src/verifier/presentations/dto/presentation-config-create.dto.js";
import { clientBundle } from "../shared/config-bundle.js";
import {
    getTenantAdminToken,
    IssuanceTestContext,
    readConfig,
    setupIssuanceTestApp,
} from "../utils.js";

/**
 * A token of the built-in OAuth2 server is accepted only while its client
 * exists in the token's tenant, with the roles and limits the client has now,
 * and only for the client's current credentials: not for an earlier client
 * with the same ID or an earlier secret. The tests change credentials within
 * the second a token was issued, which a check against `iat` would miss.
 */
describe("Client token revocation (e2e)", () => {
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        // The shared setup already created "pid".
        for (const file of ["pid-no-hook.json"]) {
            await request(ctx.app.getHttpServer())
                .post("/verifier/config")
                .set("Authorization", `Bearer ${ctx.authToken}`)
                .send(
                    readConfig<PresentationConfigCreateDto>(
                        join(
                            resolve(__dirname, "../fixtures"),
                            "haip/presentation",
                            file,
                        ),
                    ),
                )
                .expect(201);
        }
    });

    afterAll(async () => {
        await ctx?.app?.close();
    });

    function tokenResponse(clientId: string, secret: string) {
        return request(ctx.app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: clientId,
                client_secret: secret,
            })
            .expect(201);
    }

    async function accessToken(clientId: string, secret: string) {
        return (await tokenResponse(clientId, secret)).body
            .access_token as string;
    }

    async function createClient(
        adminToken: string,
        body: Record<string, unknown>,
    ): Promise<string> {
        const response = await request(ctx.app.getHttpServer())
            .post("/client")
            .set("Authorization", `Bearer ${adminToken}`)
            .send(body)
            .expect(201);
        return response.body.clientSecret as string;
    }

    function deleteClient(clientId: string) {
        return request(ctx.app.getHttpServer())
            .delete(`/client/${clientId}`)
            .set("Authorization", `Bearer ${ctx.authToken}`)
            .expect(204);
    }

    function issuanceOffer(token: string, configIds: string[]) {
        return request(ctx.app.getHttpServer())
            .post("/issuer/offer")
            .set("Authorization", `Bearer ${token}`)
            .send({
                response_type: ResponseType.URI,
                credentialConfigurationIds: configIds,
                flow: "pre_authorized_code",
            });
    }

    function presentationRequest(token: string, requestId: string) {
        return request(ctx.app.getHttpServer())
            .post("/verifier/offer")
            .set("Authorization", `Bearer ${token}`)
            .send({ response_type: ResponseType.URI, requestId });
    }

    /** Turn a client into one created by 9.x, which has no tokensValidAfter. */
    function makeLegacy(clientId: string) {
        return ctx.app
            .get<Repository<ClientEntity>>(getRepositoryToken(ClientEntity))
            .update({ clientId }, { tokensValidAfter: null });
    }

    async function storedTokensValidAfter(clientId: string) {
        const client = await ctx.app
            .get<Repository<ClientEntity>>(getRepositoryToken(ClientEntity))
            .findOneByOrFail({ clientId });
        return client.tokensValidAfter;
    }

    function rootToken() {
        return accessToken(ctx.clientId, ctx.clientSecret);
    }

    async function createTenant(id: string) {
        const response = await request(ctx.app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${await rootToken()}`)
            .send({ id, name: id, roles: [Role.IssuanceOffer] })
            .expect(201);
        return response.body.client as {
            clientId: string;
            clientSecret: string;
        };
    }

    function listClients(token: string) {
        return request(ctx.app.getHttpServer())
            .get("/client")
            .set("Authorization", `Bearer ${token}`);
    }

    test("the token response has no refresh token", async () => {
        const response = await tokenResponse(ctx.clientId, ctx.clientSecret);

        expect(response.body.access_token).toBeDefined();
        expect(response.body).not.toHaveProperty("refresh_token");
    });

    test("a deleted client's token is rejected, also for configs outside its limits", async () => {
        const clientId = "revoked-restricted";
        const token = await accessToken(
            clientId,
            await createClient(ctx.authToken, {
                clientId,
                roles: [Role.IssuanceOffer, Role.PresentationRequest],
                allowedIssuanceConfigs: ["pid-no-key"],
                allowedPresentationConfigs: ["pid-no-hook"],
            }),
        );
        expect((await issuanceOffer(token, ["pid-no-key"])).status).toBe(201);
        expect((await issuanceOffer(token, ["citizen"])).status).toBe(403);
        expect((await presentationRequest(token, "pid")).status).toBe(403);

        await deleteClient(clientId);

        expect((await issuanceOffer(token, ["pid-no-key"])).status).toBe(401);
        expect((await issuanceOffer(token, ["citizen"])).status).toBe(401);
        expect((await presentationRequest(token, "pid-no-hook")).status).toBe(
            401,
        );
        expect((await presentationRequest(token, "pid")).status).toBe(401);
    });

    test("a refresh token issued before 10.0 is not accepted as a bearer token", async () => {
        const clientId = "legacy-refresh";
        await createClient(ctx.authToken, {
            clientId,
            roles: [Role.IssuanceOffer],
        });
        // Clients from 9.x have no tokensValidAfter, and their tokens no
        // credentials_at.
        await makeLegacy(clientId);
        // 9.x signed both tokens with the same claims and only another expiry.
        const jwt = ctx.app.get(JwtService);
        const issue = (expiresInSeconds: number) =>
            jwt.generateToken(
                { roles: [Role.IssuanceOffer], tenant_id: "root" },
                {
                    expiresInSeconds,
                    audience: "eudiplo-service",
                    subject: clientId,
                },
            );

        const access = await issuanceOffer(await issue(24 * 60 * 60), [
            "pid-no-key",
        ]);
        const refresh = await issuanceOffer(await issue(30 * 24 * 60 * 60), [
            "pid-no-key",
        ]);

        expect(access.status).toBe(201);
        expect(refresh.status).toBe(401);
    });

    test("deleting a tenant ends the access of its clients", async () => {
        const rootToken = await accessToken(ctx.clientId, ctx.clientSecret);
        const tenant = await request(ctx.app.getHttpServer())
            .post("/tenant")
            .set("Authorization", `Bearer ${rootToken}`)
            .send({
                id: "token-revocation-deleted",
                name: "Deleted",
                roles: [Role.IssuanceOffer],
            })
            .expect(201);
        const adminToken = await accessToken(
            tenant.body.client.clientId,
            tenant.body.client.clientSecret,
        );
        const listClients = () =>
            request(ctx.app.getHttpServer())
                .get("/client")
                .set("Authorization", `Bearer ${adminToken}`);
        expect((await listClients()).status).toBe(200);

        await request(ctx.app.getHttpServer())
            .delete("/tenant/token-revocation-deleted")
            .set("Authorization", `Bearer ${rootToken}`)
            .expect(204);

        expect((await listClients()).status).toBe(401);
    });

    test("a token is rejected once its client ID belongs to another tenant", async () => {
        const clientId = "moved-client";
        const token = await accessToken(
            clientId,
            await createClient(ctx.authToken, {
                clientId,
                roles: [Role.IssuanceOffer],
            }),
        );
        await deleteClient(clientId);

        const tenant = await request(ctx.app.getHttpServer())
            .post("/tenant")
            .set(
                "Authorization",
                `Bearer ${await accessToken(ctx.clientId, ctx.clientSecret)}`,
            )
            .send({
                id: "token-revocation-other",
                name: "Other",
                roles: [Role.IssuanceOffer],
            })
            .expect(201);
        await createClient(
            await accessToken(
                tenant.body.client.clientId,
                tenant.body.client.clientSecret,
            ),
            { clientId, roles: [Role.IssuanceOffer] },
        );

        expect((await issuanceOffer(token, ["pid-no-key"])).status).toBe(401);
    });

    test("role and limit changes apply to tokens already issued", async () => {
        const clientId = "changed-client";
        const token = await accessToken(
            clientId,
            await createClient(ctx.authToken, {
                clientId,
                roles: [Role.IssuanceOffer, Role.PresentationRequest],
            }),
        );
        expect((await issuanceOffer(token, ["citizen"])).status).toBe(201);

        await request(ctx.app.getHttpServer())
            .patch(`/client/${clientId}`)
            .set("Authorization", `Bearer ${ctx.authToken}`)
            .send({
                roles: [Role.PresentationRequest],
                allowedPresentationConfigs: ["pid-no-hook"],
            })
            .expect(200);

        expect((await issuanceOffer(token, ["citizen"])).status).toBe(403);
        expect((await presentationRequest(token, "pid")).status).toBe(403);
        expect((await presentationRequest(token, "pid-no-hook")).status).toBe(
            201,
        );
    });

    test("a client re-created with the same ID does not revive the old tokens", async () => {
        const clientId = "recreated-client";
        const oldToken = await accessToken(
            clientId,
            await createClient(ctx.authToken, {
                clientId,
                roles: [Role.PresentationRequest],
            }),
        );
        await deleteClient(clientId);
        const secret = await createClient(ctx.authToken, {
            clientId,
            roles: [Role.IssuanceOffer],
        });

        expect((await issuanceOffer(oldToken, ["pid-no-key"])).status).toBe(
            401,
        );
        const newToken = await accessToken(clientId, secret);
        expect((await issuanceOffer(newToken, ["pid-no-key"])).status).toBe(
            201,
        );
    });

    test("re-creating a deleted tenant does not revive its admin's tokens", async () => {
        const tenantId = "token-revocation-recreated";
        const oldAdmin = await createTenant(tenantId);
        const oldToken = await accessToken(
            oldAdmin.clientId,
            oldAdmin.clientSecret,
        );
        expect((await listClients(oldToken)).status).toBe(200);
        await request(ctx.app.getHttpServer())
            .delete(`/tenant/${tenantId}`)
            .set("Authorization", `Bearer ${await rootToken()}`)
            .expect(204);

        const admin = await createTenant(tenantId);

        expect((await listClients(oldToken)).status).toBe(401);
        const newToken = await accessToken(admin.clientId, admin.clientSecret);
        expect((await listClients(newToken)).status).toBe(200);
    });

    test("creating an existing tenant again ends its admin's old tokens", async () => {
        const tenantId = "token-revocation-reposted";
        const oldAdmin = await createTenant(tenantId);
        const oldToken = await accessToken(
            oldAdmin.clientId,
            oldAdmin.clientSecret,
        );

        const admin = await createTenant(tenantId);

        expect((await listClients(oldToken)).status).toBe(401);
        const newToken = await accessToken(admin.clientId, admin.clientSecret);
        expect((await listClients(newToken)).status).toBe(200);
    });

    test("a client from 9.x keeps its tokens until its secret changes", async () => {
        const clientId = "legacy-rotated";
        const secret = await createClient(ctx.authToken, {
            clientId,
            roles: [Role.IssuanceOffer],
        });
        await makeLegacy(clientId);
        const token = await accessToken(clientId, secret);
        const legacyToken = await ctx.app.get(JwtService).generateToken(
            { roles: [Role.IssuanceOffer], tenant_id: "root" },
            {
                expiresInSeconds: 24 * 60 * 60,
                audience: "eudiplo-service",
                subject: clientId,
            },
        );
        expect((await issuanceOffer(token, ["pid-no-key"])).status).toBe(201);
        expect((await issuanceOffer(legacyToken, ["pid-no-key"])).status).toBe(
            201,
        );

        await request(ctx.app.getHttpServer())
            .post(`/client/${clientId}/rotate-secret`)
            .set("Authorization", `Bearer ${ctx.authToken}`)
            .expect(201);

        expect((await issuanceOffer(token, ["pid-no-key"])).status).toBe(401);
        expect((await issuanceOffer(legacyToken, ["pid-no-key"])).status).toBe(
            401,
        );
    });

    test("rotating a secret ends the tokens issued with the old one", async () => {
        const clientId = "rotated-client";
        const oldToken = await accessToken(
            clientId,
            await createClient(ctx.authToken, {
                clientId,
                roles: [Role.IssuanceOffer],
            }),
        );

        const rotated = await request(ctx.app.getHttpServer())
            .post(`/client/${clientId}/rotate-secret`)
            .set("Authorization", `Bearer ${ctx.authToken}`)
            .expect(201);

        expect((await issuanceOffer(oldToken, ["pid-no-key"])).status).toBe(
            401,
        );
        const newToken = await accessToken(clientId, rotated.body.secret);
        expect((await issuanceOffer(newToken, ["pid-no-key"])).status).toBe(
            201,
        );
    });

    describe("configuration bundle", () => {
        const tenantId = "token-revocation-bundle";
        let adminToken: string;

        beforeAll(async () => {
            adminToken = await getTenantAdminToken(
                ctx.app,
                ctx.clientId,
                ctx.clientSecret,
                tenantId,
                [Role.Clients, Role.IssuanceOffer],
            );
        });

        async function apply(
            spec: Record<string, unknown> & { clientId: string },
        ) {
            const bundle = clientBundle(tenantId, spec);
            const planned = await request(ctx.app.getHttpServer())
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", `Bearer ${adminToken}`)
                .send(bundle);
            expect(planned.status, JSON.stringify(planned.body)).toBe(201);
            const imported = await request(ctx.app.getHttpServer())
                .post(
                    `/config-bundles/import?mode=upsert&planFingerprint=${planned.body.planFingerprint}`,
                )
                .set("Authorization", `Bearer ${adminToken}`)
                .send(bundle);
            expect(imported.status, JSON.stringify(imported.body)).toBe(201);
        }

        test("keeps a client from 9.x unlimited when applied with its own secret", async () => {
            const spec = {
                clientId: "bundle-legacy-client",
                secret: "secret-of-bundle-legacy-client",
                roles: [Role.Clients],
            };
            await apply(spec);
            await makeLegacy(spec.clientId);
            const token = await accessToken(spec.clientId, spec.secret);

            await apply({ ...spec, description: "applied again" });

            expect(await storedTokensValidAfter(spec.clientId)).toBeNull();
            expect((await listClients(token)).status).toBe(200);
        });

        test("keeps tokens while the secret stays the same and ends them when it changes", async () => {
            const clientId = "bundle-client";
            const spec = {
                clientId,
                secret: "first-secret-of-bundle-client",
                roles: [Role.Clients],
            };
            await apply(spec);
            const oldToken = await accessToken(clientId, spec.secret);

            await apply({ ...spec, description: "applied again" });
            expect((await listClients(oldToken)).status).toBe(200);

            await apply({ ...spec, secret: "second-secret-of-bundle-client" });
            expect((await listClients(oldToken)).status).toBe(401);
        });
    });

    describe("startup configuration import", () => {
        const clientId = "imported-client";
        let configFolder: string;
        let configService: ConfigService;
        let original: Record<string, unknown>;

        beforeAll(() => {
            configFolder = mkdtempSync(join(tmpdir(), "eudiplo-token-import-"));
            mkdirSync(join(configFolder, "root", "clients"), {
                recursive: true,
            });
            configService = ctx.app.get(ConfigService);
            original = {
                CONFIG_FOLDER: configService.get("CONFIG_FOLDER"),
                CONFIG_IMPORT_MODE: configService.get("CONFIG_IMPORT_MODE"),
            };
            configService.set("CONFIG_FOLDER", configFolder);
            configService.set("CONFIG_IMPORT_MODE", "upsert");
        });

        afterAll(() => {
            for (const [key, value] of Object.entries(original)) {
                configService.set(key, value);
            }
            rmSync(configFolder, { recursive: true, force: true });
        });

        function clientFile(id: string) {
            return join(configFolder, "root", "clients", `${id}.json`);
        }

        function importClient(secret: string, id = clientId) {
            writeFileSync(
                clientFile(id),
                JSON.stringify({
                    clientId: id,
                    secret,
                    roles: [Role.IssuanceOffer],
                }),
            );
            return ctx.app
                .get<ClientsProvider>(CLIENTS_PROVIDER)
                .importForTenant("root");
        }

        test("keeps tokens of a client it re-creates with the same secret", async () => {
            const secret = "first-secret-of-imported-client";
            await importClient(secret);
            const oldToken = await accessToken(clientId, secret);

            await importClient(secret);
            expect((await issuanceOffer(oldToken, ["pid-no-key"])).status).toBe(
                201,
            );

            await importClient("second-secret-of-imported-client");
            expect((await issuanceOffer(oldToken, ["pid-no-key"])).status).toBe(
                401,
            );
        });

        test("ends the tokens of a client file without secret on every import", async () => {
            const id = "imported-without-secret";
            writeFileSync(
                clientFile(id),
                JSON.stringify({ clientId: id, roles: [Role.IssuanceOffer] }),
            );
            const provider = ctx.app.get<ClientsProvider>(CLIENTS_PROVIDER);
            await provider.importForTenant("root");
            // Nobody knows the random secret: set one to get a token.
            const secret = await provider.rotateClientSecret("root", id);
            const token = await accessToken(id, secret);
            expect((await issuanceOffer(token, ["pid-no-key"])).status).toBe(
                201,
            );

            await provider.importForTenant("root");
            rmSync(clientFile(id));

            expect((await issuanceOffer(token, ["pid-no-key"])).status).toBe(
                401,
            );
        });

        test("does not take over the client ID of the root client", async () => {
            await importClient("taken-over-secret", ctx.clientId);
            rmSync(clientFile(ctx.clientId));

            await request(ctx.app.getHttpServer())
                .post("/api/oauth2/token")
                .send({
                    grant_type: "client_credentials",
                    client_id: ctx.clientId,
                    client_secret: "taken-over-secret",
                })
                .expect(401);
            expect(await rootToken()).toBeTruthy();
        });
    });
});
