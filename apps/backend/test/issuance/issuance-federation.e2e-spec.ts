import { INestApplication } from "@nestjs/common";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import { FederationTrustMode } from "../../src/issuer/configuration/issuance/dto/federation-config.dto.js";
import { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { IssuanceTestContext, setupIssuanceTestApp } from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Issuance - OpenID Federation", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    beforeEach(() => {
        nock.disableNetConnect();
        nock.enableNetConnect(/127\.0\.0\.1|localhost/);
    });

    afterEach(() => {
        nock.cleanAll();
        nock.enableNetConnect();
    });

    afterAll(async () => {
        await app?.close();
    });

    async function updateIssuanceConfig(update: Partial<IssuanceDto>) {
        const current = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        return request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...current.body,
                ...update,
            })
            .expect(201);
    }

    function encodeBase64UrlJson(value: unknown): string {
        return Buffer.from(JSON.stringify(value)).toString("base64url");
    }

    function makeUnsignedJwt(payload: Record<string, unknown>): string {
        const header = encodeBase64UrlJson({ alg: "none", typ: "JWT" });
        const body = encodeBase64UrlJson(payload);
        return `${header}.${body}.`;
    }

    test("issuer metadata includes federated auth server when trust chain is valid", async () => {
        const authServer = "https://as-fed.example.org";
        const trustAnchor = "https://ta-fed.example.org";

        nock(authServer)
            .get("/.well-known/openid-federation")
            .reply(200, {
                sub: authServer,
                authority_hints: [trustAnchor],
            });

        nock(authServer)
            .get("/.well-known/oauth-authorization-server")
            .reply(200, {
                issuer: authServer,
                authorization_endpoint: `${authServer}/authorize`,
                token_endpoint: `${authServer}/token`,
                jwks_uri: `${authServer}/jwks`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code"],
                token_endpoint_auth_methods_supported: ["private_key_jwt"],
            });

        await updateIssuanceConfig({
            authorizationServers: [
                {
                    id: "external-fed-auth",
                    type: "external",
                    issuer: authServer,
                    label: authServer,
                },
            ],
            federation: {
                mode: FederationTrustMode.FEDERATION_ONLY,
                entityId: "http://localhost:3000/issuers/root",
                trustAnchors: [
                    {
                        entityId: trustAnchor,
                        entityConfigurationUri: `${trustAnchor}/.well-known/openid-federation`,
                    },
                ],
            },
        });

        const metadata = await request(app.getHttpServer())
            .get("/.well-known/openid-credential-issuer/issuers/root")
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);

        expect(metadata.body.authorization_servers).toContain(authServer);
    });

    test("issuer metadata accepts JWT entity configuration for federation verification", async () => {
        const authServer = "https://as-fed-jwt.example.org";
        const trustAnchor = "https://ta-fed.example.org";

        const federationScope = nock(authServer)
            .get("/.well-known/openid-federation")
            .reply(
                200,
                makeUnsignedJwt({
                    sub: authServer,
                    authority_hints: [trustAnchor],
                }),
                { "content-type": "application/entity-statement+jwt" },
            );

        nock(authServer)
            .get("/.well-known/oauth-authorization-server")
            .reply(200, {
                issuer: authServer,
                authorization_endpoint: `${authServer}/authorize`,
                token_endpoint: `${authServer}/token`,
                jwks_uri: `${authServer}/jwks`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code"],
                token_endpoint_auth_methods_supported: ["private_key_jwt"],
            });

        await updateIssuanceConfig({
            authorizationServers: [
                {
                    id: "external-fed-auth",
                    type: "external",
                    issuer: authServer,
                    label: authServer,
                },
            ],
            federation: {
                mode: FederationTrustMode.FEDERATION_ONLY,
                entityId: "http://localhost:3000/issuers/root",
                trustAnchors: [
                    {
                        entityId: trustAnchor,
                        entityConfigurationUri: `${trustAnchor}/.well-known/openid-federation`,
                    },
                ],
            },
        });

        const metadata = await request(app.getHttpServer())
            .get("/.well-known/openid-credential-issuer/issuers/root")
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);

        expect(metadata.body.authorization_servers).toContain(authServer);
        expect(federationScope.isDone()).toBe(true);
    });

    test("issuer metadata fails when configured auth server is not trusted by federation", async () => {
        const authServer = "https://as-untrusted.example.org";
        const trustAnchor = "https://ta-fed.example.org";

        nock(authServer)
            .get("/.well-known/openid-federation")
            .reply(200, {
                sub: authServer,
                authority_hints: ["https://other-anchor.example.org"],
            });

        await updateIssuanceConfig({
            authorizationServers: [
                {
                    id: "external-fed-auth",
                    type: "external",
                    issuer: authServer,
                    label: authServer,
                },
            ],
            federation: {
                mode: FederationTrustMode.FEDERATION_ONLY,
                entityId: "http://localhost:3000/issuers/root",
                trustAnchors: [
                    {
                        entityId: trustAnchor,
                        entityConfigurationUri: `${trustAnchor}/.well-known/openid-federation`,
                    },
                ],
            },
        });

        const metadata = await request(app.getHttpServer())
            .get("/.well-known/openid-credential-issuer/issuers/root")
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect((res) => {
                expect(res.status).not.toBe(200);
                expect([400, 500]).toContain(res.status);
            });

        const message =
            typeof metadata.body?.message === "string"
                ? metadata.body.message
                : JSON.stringify(metadata.body);
        expect(message).toContain("trusted");
    });
});
