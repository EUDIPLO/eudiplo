import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AllExceptionsFilter } from "../../src/all-exceptions.filter.js";
import { NOT_A_JWT_MESSAGE } from "../../src/auth/auth.guard.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";

const AUDIENCE = "eudiplo-api";
const TENANT = "generic-acme";

/**
 * EUDIPLO with `OIDC_PROVIDER=generic` against an identity provider that is
 * not Keycloak: discovery and keys at Authentik's paths, an issuer with a
 * trailing slash, and the roles in a nested claim.
 */
describe("Generic OIDC provider (e2e)", () => {
    let app: INestApplication<App>;
    let provider: Server;
    let base: string;
    let issuer: string;
    let sign: (
        claims: JWTPayload,
        options?: { audience?: string; issuer?: string; foreignKey?: boolean },
    ) => Promise<string>;

    const as = (token: string) => ({
        get: (path: string) =>
            request(app.getHttpServer())
                .get(path)
                .set("Authorization", `Bearer ${token}`),
        post: (path: string, body: object) =>
            request(app.getHttpServer())
                .post(path)
                .set("Authorization", `Bearer ${token}`)
                .send(body),
    });

    /** A token of a person in the tenant with the given roles in the nested claim. */
    const personToken = (roles: Role[]) =>
        sign({ sub: "person-1", tenant_id: TENANT, eudiplo: { roles } });

    beforeAll(async () => {
        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const foreign = await generateKeyPair("RS256");
        const jwk = {
            ...(await exportJWK(publicKey)),
            kid: "key-1",
            alg: "RS256",
            use: "sig",
        };
        provider = createServer((req, res) => {
            const documents: Record<string, object> = {
                "/application/o/eudiplo/.well-known/openid-configuration": {
                    issuer,
                    authorization_endpoint: `${base}/application/o/authorize/`,
                    token_endpoint: `${base}/application/o/token/`,
                    jwks_uri: `${base}/application/o/eudiplo/jwks/`,
                    end_session_endpoint: `${base}/application/o/eudiplo/end-session/`,
                },
                "/application/o/eudiplo/jwks/": { keys: [jwk] },
            };
            const document = documents[req.url ?? ""];
            res.writeHead(document ? 200 : 404, {
                "content-type": "application/json",
            });
            res.end(JSON.stringify(document ?? {}));
        });
        await new Promise<void>((resolve) =>
            provider.listen(0, "127.0.0.1", resolve),
        );
        base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
        issuer = `${base}/application/o/eudiplo/`;
        sign = (claims, options = {}) =>
            new SignJWT(claims)
                .setProtectedHeader({ alg: "RS256", kid: "key-1" })
                .setIssuer(options.issuer ?? issuer)
                .setAudience(options.audience ?? AUDIENCE)
                .setIssuedAt()
                .setExpirationTime("5m")
                .sign(options.foreignKey ? foreign.privateKey : privateKey);

        // The fixtures use a fixed tenant ID.
        rmSync("../../tmp/service.db", { force: true });
        vi.stubEnv("OIDC", issuer);
        vi.stubEnv("OIDC_PROVIDER", "generic");
        vi.stubEnv("OIDC_AUDIENCE", AUDIENCE);
        vi.stubEnv("OIDC_ROLES_CLAIM", "eudiplo.roles");
        vi.stubEnv("CONFIG_IMPORT_MODE", "disabled");
        // AppModule reads the environment when it is imported.
        const { AppModule } = await import("../../src/app.module.js");
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();

        const operator = await sign({
            sub: "operator",
            eudiplo: { roles: [Role.Tenants] },
        });
        await as(operator)
            .post("/tenant", { id: TENANT, name: "Acme" })
            .expect(201);
    });

    afterAll(async () => {
        await app?.close();
        await new Promise((resolve) => provider?.close(resolve));
        vi.unstubAllEnvs();
    });

    test("accepts the provider's token and resolves its tenant and nested roles", async () => {
        // Session counts need a tenant and sessions:read.
        await as(await personToken([Role.SessionsRead]))
            .get("/session/stats")
            .expect(200);
        await as(await personToken([Role.Keys]))
            .get("/session/stats")
            .expect(403);
    });

    test("refuses a token for another audience", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { audience: "other-app" },
        );

        await as(token).get("/session/stats").expect(401);
    });

    test("refuses a token of another issuer, also one without the trailing slash", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { issuer: issuer.slice(0, -1) },
        );

        await as(token).get("/session/stats").expect(401);
    });

    test("refuses a token signed with another key", async () => {
        const token = await sign(
            {
                sub: "person-1",
                tenant_id: TENANT,
                eudiplo: { roles: [Role.SessionsRead] },
            },
            { foreignKey: true },
        );

        await as(token).get("/session/stats").expect(401);
    });

    test("names a bearer token that is no JWT", async () => {
        const response = await as("opaque-zitadel-token")
            .get("/session/stats")
            .expect(401);

        expect(response.body.message).toBe(NOT_A_JWT_MESSAGE);
    });

    test("leaves clients and people to the identity provider", async () => {
        const token = await personToken([Role.Clients, Role.Users]);

        await as(token).get("/client").expect(501);
        await as(token).get("/user").expect(501);
    });

    test("refuses a tenant with an admin client before it creates the tenant", async () => {
        const operator = await sign({
            sub: "operator",
            eudiplo: { roles: [Role.Tenants] },
        });

        await as(operator)
            .post("/tenant", {
                id: "generic-half",
                name: "Half",
                roles: [Role.IssuanceOffer],
            })
            .expect(501);
        const tenants = await as(operator).get("/tenant").expect(200);
        expect(
            tenants.body.map((tenant: { id: string }) => tenant.id),
        ).not.toContain("generic-half");
    });

    test("advertises the provider's endpoints and no single sign-on for the Web Client", async () => {
        const response = await request(app.getHttpServer())
            .get("/.well-known/oauth-authorization-server")
            .expect(200);

        expect(response.body).toMatchObject({
            issuer,
            token_endpoint: `${base}/application/o/token/`,
            jwks_uri: `${base}/application/o/eudiplo/jwks/`,
        });
        expect(response.body).not.toHaveProperty("ui_client_id");
    });

    test("has no built-in token endpoint", async () => {
        await request(app.getHttpServer())
            .post("/api/oauth2/token")
            .send({
                grant_type: "client_credentials",
                client_id: "root",
                client_secret: "root",
            })
            .expect(401);
    });
});
