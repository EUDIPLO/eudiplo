import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Role } from "../../src/auth/roles/role.enum.js";
import { IssuanceService } from "../../src/issuer/configuration/issuance/issuance.service.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    clientToken,
    getTenantAdminToken,
    setupIssuanceTestApp,
} from "../utils.js";

const UNKNOWN_SESSION = "00000000-0000-4000-8000-000000000000";

/**
 * The 11.0 role model over HTTP: read roles, keys:export, manage roles that
 * include the roles that use sessions, and grants of included roles.
 */
describe("Role model (e2e)", () => {
    let app: INestApplication<App>;
    let adminToken: string;
    let keyChainId: string;
    let openIssuance: string;
    let openPresentation: string;

    const as = (token: string) => ({
        get: (path: string) =>
            request(app.getHttpServer())
                .get(path)
                .set("Authorization", `Bearer ${token}`),
        post: (path: string, body: object = {}) =>
            request(app.getHttpServer())
                .post(path)
                .set("Authorization", `Bearer ${token}`)
                .send(body),
        put: (path: string, body: object = {}) =>
            request(app.getHttpServer())
                .put(path)
                .set("Authorization", `Bearer ${token}`)
                .send(body),
        delete: (path: string) =>
            request(app.getHttpServer())
                .delete(path)
                .set("Authorization", `Bearer ${token}`),
    });
    const token = (clientId: string, roles: Role[]) =>
        clientToken(app, adminToken, clientId, roles);

    beforeAll(async () => {
        // tenant:admin lets the tenant client grant every role.
        ({ app, authToken: adminToken } = await setupIssuanceTestApp({
            extraRoles: [Role.TenantAdmin],
        }));
        const keyChains = await as(adminToken).get("/key-chain").expect(200);
        keyChainId = keyChains.body[0].id;
        openIssuance = (
            await as(adminToken)
                .post("/issuer/offer", {
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                })
                .expect(201)
        ).body.session;
        openPresentation = (
            await as(adminToken)
                .post("/verifier/offer", {
                    response_type: ResponseType.URI,
                    requestId: "pid",
                })
                .expect(201)
        ).body.session;
    });

    afterAll(async () => {
        await app?.close();
    });

    describe("issuance:read", () => {
        let reader: string;

        beforeAll(async () => {
            reader = await token("role-model-issuance-reader", [
                Role.IssuanceRead,
            ]);
        });

        test.each([
            "/issuer/credentials",
            "/issuer/config",
            "/issuer/attribute-providers",
            "/issuer/webhook-endpoints",
            "/status-lists",
            "/trust-list",
            "/key-chain",
            "/key-chain/access/default",
            "/session-config",
        ])("reads %s", async (path) => {
            await as(reader).get(path).expect(200);
        });

        test("reads single resources and their history", async () => {
            const credentials = await as(reader)
                .get("/issuer/credentials")
                .expect(200);
            await as(reader)
                .get(`/issuer/credentials/${credentials.body[0].id}`)
                .expect(200);
            const lists = await as(adminToken).get("/trust-list").expect(200);
            if (lists.body.length > 0) {
                const id = lists.body[0].id;
                await as(reader).get(`/trust-list/${id}`).expect(200);
                await as(reader).get(`/trust-list/${id}/versions`).expect(200);
            }
            await as(reader).get(`/key-chain/${keyChainId}`).expect(200);
        });

        test("gets the default issuer settings of a tenant without stored ones, and nothing is stored", async () => {
            const config = app.get(ConfigService);
            const freshAdmin = await getTenantAdminToken(
                app,
                config.getOrThrow<string>("AUTH_CLIENT_ID"),
                config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
                "role-model-fresh",
                [Role.Clients],
            );
            const freshReader = await clientToken(
                app,
                freshAdmin,
                "role-model-fresh-reader",
                [Role.IssuanceRead],
            );

            const response = await as(freshReader)
                .get("/issuer/config")
                .expect(200);

            expect(response.body.authorizationServers).toEqual([
                expect.objectContaining({ type: "built-in" }),
            ]);
            await expect(
                app
                    .get(IssuanceService)
                    .getIssuanceConfiguration("role-model-fresh"),
            ).rejects.toThrow();
        });

        test("changes nothing and creates no offer", async () => {
            await as(reader).post("/issuer/credentials", {}).expect(403);
            await as(reader).post("/key-chain", {}).expect(403);
            await as(reader)
                .put("/key-chain/access/default", {
                    defaultAccessKeyChainId: null,
                })
                .expect(403);
            await as(reader)
                .post("/issuer/offer", {
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                })
                .expect(403);
            await as(reader).get("/verifier/config").expect(403);
        });
    });

    describe("presentation:read", () => {
        let reader: string;

        beforeAll(async () => {
            reader = await token("role-model-presentation-reader", [
                Role.PresentationRead,
            ]);
        });

        test("reads a single presentation configuration", async () => {
            await as(reader).get("/verifier/config/pid").expect(200);
        });

        test.each([
            "/verifier/config",
            "/verifier/oidc-clients",
            "/trust-list",
            "/key-chain",
        ])("reads %s", async (path) => {
            await as(reader).get(path).expect(200);
        });

        test("changes nothing and creates no request", async () => {
            await as(reader).post("/verifier/config", {}).expect(403);
            await as(reader)
                .post("/verifier/offer", {
                    response_type: ResponseType.URI,
                    requestId: "pid",
                })
                .expect(403);
            await as(reader).get("/issuer/credentials").expect(403);
        });
    });

    describe("keys:export", () => {
        test("exports key chains and manages the KMS settings without tenant:admin", async () => {
            const exporter = await token("role-model-key-exporter", [
                Role.KeysExport,
            ]);
            await as(exporter)
                .get(`/key-chain/${keyChainId}/export`)
                .expect(200);
            await as(exporter).get("/key-chain/providers/config").expect(200);
            await as(exporter)
                .get(
                    `/config-bundles/resources/KeyChain/${keyChainId}/document`,
                )
                .expect(200);
            // keys:export includes keys:manage.
            await as(exporter).get("/key-chain").expect(200);
        });

        test("is not part of keys:manage", async () => {
            const custodian = await token("role-model-key-custodian", [
                Role.Keys,
            ]);
            await as(custodian)
                .get(`/key-chain/${keyChainId}/export`)
                .expect(403);
            await as(custodian)
                .get(
                    `/config-bundles/resources/KeyChain/${keyChainId}/document`,
                )
                .expect(403);
        });
    });

    describe("manage roles include the roles that use sessions", () => {
        test("issuance:manage reads and deletes issuance sessions but not presentation sessions", async () => {
            const issuer = await token("role-model-issuance-manager", [
                Role.Issuances,
            ]);
            await as(issuer).get(`/session/${openIssuance}`).expect(200);
            // Answered like a session that does not exist.
            const unknown = await as(issuer).get(`/session/${UNKNOWN_SESSION}`);
            expect(unknown.status).not.toBe(200);
            const other = await as(issuer).get(`/session/${openPresentation}`);
            expect(other.status).toBe(unknown.status);
            await as(issuer).delete(`/session/${openIssuance}`).expect(204);
        });

        test("presentation:manage reads presentation sessions but not issuance sessions", async () => {
            const verifier = await token("role-model-presentation-manager", [
                Role.Presentations,
            ]);
            await as(verifier).get(`/session/${openPresentation}`).expect(200);
            const issuance = (
                await as(adminToken)
                    .post("/issuer/offer", {
                        response_type: "uri",
                        credentialConfigurationIds: ["pid-no-key"],
                        flow: "pre_authorized_code",
                    })
                    .expect(201)
            ).body.session;
            const unknown = await as(verifier).get(
                `/session/${UNKNOWN_SESSION}`,
            );
            const other = await as(verifier).get(`/session/${issuance}`);
            expect(other.status).toBe(unknown.status);
        });
    });

    describe("grants", () => {
        test("a caller grants the roles its roles include, and no others", async () => {
            const manager = await token("role-model-granting-manager", [
                Role.Clients,
                Role.Issuances,
            ]);
            await as(manager)
                .post("/client", {
                    clientId: "role-model-granted-reader",
                    roles: [Role.IssuanceRead, Role.CredentialStatus],
                })
                .expect(201);
            await as(manager)
                .post("/client", {
                    clientId: "role-model-refused-custodian",
                    roles: [Role.Keys],
                })
                .expect(403);
        });
    });
});
