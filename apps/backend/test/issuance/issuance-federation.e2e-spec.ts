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
import { FederationTrustService } from "../../src/trust/federation-trust.service.js";
import { serveFederation } from "../federation/federation-fixture.js";
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

    const TRUST_ANCHOR = "https://ta-fed.example.org";

    function serveAuthorizationServerMetadata(authServer: string) {
        nock(authServer)
            .get("/.well-known/oauth-authorization-server")
            .optionally()
            .reply(200, {
                issuer: authServer,
                authorization_endpoint: `${authServer}/authorize`,
                token_endpoint: `${authServer}/token`,
                jwks_uri: `${authServer}/jwks`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code"],
                token_endpoint_auth_methods_supported: ["private_key_jwt"],
            });
    }

    async function configureFederatedAuthorizationServer(authServer: string) {
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
                        entityId: TRUST_ANCHOR,
                        entityConfigurationUri: `${TRUST_ANCHOR}/.well-known/openid-federation`,
                    },
                ],
            },
        });
    }

    function getIssuerMetadata() {
        return request(app.getHttpServer())
            .get("/.well-known/openid-credential-issuer/issuers/root")
            .trustLocalhost()
            .set("Accept", "application/json");
    }

    async function expectNotTrusted(reason: string) {
        const metadata = await getIssuerMetadata().expect((res) => {
            expect([400, 500]).toContain(res.status);
        });
        const message =
            typeof metadata.body?.message === "string"
                ? metadata.body.message
                : JSON.stringify(metadata.body);
        expect(message).toContain(
            "Authorization server is not trusted by OpenID Federation policy",
        );
        expect(message).toContain(reason);
    }

    beforeEach(() => {
        app.get(FederationTrustService).clearTrustCache();
    });

    test("issuer metadata includes a federated authorization server whose trust chain is valid", async () => {
        const authServer = "https://as-fed.example.org";
        await serveFederation({
            trustAnchor: TRUST_ANCHOR,
            entity: authServer,
            metadata: { oauth_authorization_server: { issuer: authServer } },
        });
        serveAuthorizationServerMetadata(authServer);
        await configureFederatedAuthorizationServer(authServer);

        const metadata = await getIssuerMetadata().expect(200);

        expect(metadata.body.authorization_servers).toContain(authServer);
    });

    test("issuer metadata fails for an authorization server outside the federation", async () => {
        const authServer = "https://as-untrusted.example.org";
        await serveFederation({
            trustAnchor: "https://other-anchor.example.org",
            entity: authServer,
            metadata: { oauth_authorization_server: { issuer: authServer } },
        });
        await configureFederatedAuthorizationServer(authServer);

        await expectNotTrusted("does not chain to a configured trust anchor");
    });

    test("issuer metadata fails for an authorization server that only names the trust anchor", async () => {
        // Matching an authority_hint alone does not establish trust.
        const authServer = "https://as-unlisted.example.org";
        await serveFederation({
            trustAnchor: TRUST_ANCHOR,
            entity: authServer,
            metadata: { oauth_authorization_server: { issuer: authServer } },
            listed: false,
        });
        await configureFederatedAuthorizationServer(authServer);

        await expectNotTrusted("status 404");
    });

    test("issuer metadata fails for an unsigned entity configuration", async () => {
        const authServer = "https://as-unsigned.example.org";
        const encode = (value: unknown) =>
            Buffer.from(JSON.stringify(value)).toString("base64url");
        nock(authServer)
            .get("/.well-known/openid-federation")
            .reply(
                200,
                `${encode({ alg: "none", typ: "entity-statement+jwt", kid: "k" })}.${encode(
                    {
                        iss: authServer,
                        sub: authServer,
                        iat: Math.floor(Date.now() / 1000),
                        exp: Math.floor(Date.now() / 1000) + 3600,
                        jwks: { keys: [{ kty: "EC", kid: "k" }] },
                        authority_hints: [TRUST_ANCHOR],
                    },
                )}.`,
                { "content-type": "application/entity-statement+jwt" },
            );
        await configureFederatedAuthorizationServer(authServer);

        await expectNotTrusted(
            "entity configuration of 'https://as-unsigned.example.org'",
        );
    });

    test("issuer metadata fails for a federation entity without authorization server metadata", async () => {
        const authServer = "https://as-no-metadata.example.org";
        await serveFederation({
            trustAnchor: TRUST_ANCHOR,
            entity: authServer,
            metadata: {},
        });
        await configureFederatedAuthorizationServer(authServer);

        await expectNotTrusted(
            "has no oauth_authorization_server or openid_provider metadata",
        );
    });
});
