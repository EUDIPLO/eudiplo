import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import {
    type Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { type CryptoKey, createLocalJWKSet, jwtVerify } from "jose";
import request from "supertest";
import type { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import {
    callbacks,
    createTestFetch,
    encryptVpToken,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";

const TENANT = "root";
const REDIRECT = "https://rp.example.com/callback";
const ACR_SAME_DEVICE = "urn:eudiplo:acr:oidc:same-device";
const ACR_CROSS_DEVICE = "urn:eudiplo:acr:oidc:cross-device";

describe("OpenID Provider", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let privateIssuerKey: CryptoKey;
    let issuerCertChain: string[];
    let statusListService: StatusListService;
    let wallet: Openid4vpClient;
    let clientId: string;
    let clientSecret: string;

    const base = () => `/verifiers/${TENANT}/oidc`;
    const issuer = () => `${host}${base()}`;
    const basic = (id = clientId, secret = clientSecret) =>
        `Basic ${Buffer.from(
            `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`,
        ).toString("base64")}`;

    /** Path and query of an absolute URL of this backend. */
    const local = (url: string) => {
        const parsed = new URL(url, host);
        return parsed.pathname + parsed.search;
    };

    function pkce() {
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256")
            .update(verifier)
            .digest("base64url");
        return { verifier, challenge };
    }

    /** PAR, authorize and the sign-in page, as the browser sees them. */
    async function startSignIn(extra: Record<string, string> = {}) {
        const { verifier, challenge } = pkce();
        const par = await request(app.getHttpServer())
            .post(`${base()}/par`)
            .set("Authorization", basic())
            .type("form")
            .send({
                response_type: "code",
                redirect_uri: REDIRECT,
                scope: "openid pid",
                state: "state-1",
                nonce: "nonce-1",
                code_challenge: challenge,
                code_challenge_method: "S256",
                ...extra,
            })
            .expect(201);
        expect(par.headers["cache-control"]).toBe("no-store");

        const authorize = await request(app.getHttpServer())
            .get(`${base()}/authorize`)
            .query({ client_id: clientId, request_uri: par.body.request_uri })
            .expect(303);
        const cookie = (authorize.headers["set-cookie"] as unknown as string[])
            .map((value) => value.split(";")[0])
            .join("; ");
        expect(authorize.headers["set-cookie"]?.[0]).toContain("HttpOnly");
        const pagePath = local(authorize.headers.location);

        const page = await request(app.getHttpServer())
            .get(pagePath)
            .set("Cookie", cookie)
            .expect(200);
        expect(page.headers["content-security-policy"]).toContain(
            "frame-ancestors 'none'",
        );
        const links = [...page.text.matchAll(/href="([^"]+)"/g)].map((match) =>
            match[1].replaceAll("&amp;", "&"),
        );
        const sameDevice = links.find((link) =>
            link.startsWith("openid4vp://"),
        )!;
        expect(sameDevice).toBeDefined();
        expect(page.text).toContain("<svg");
        return { verifier, cookie, pagePath, sameDevice };
    }

    /** The wallet presents the PID for an `openid4vp://` request. */
    async function present(walletRequest: string) {
        const authRequest = wallet.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: walletRequest,
        });
        const resolved = await wallet.resolveOpenid4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        const vpToken = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
            },
            privateIssuerKey,
            issuerCertChain,
            statusListService,
            "pid",
        );
        const response = await wallet.createOpenid4vpAuthorizationResponse({
            authorizationRequestPayload: authRequest.params,
            authorizationResponsePayload: {
                response: await encryptVpToken(vpToken, "pid", resolved),
            },
            ...callbacks,
        });
        const submitted = await wallet.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload: response.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });
        expect(submitted.response.status).toBe(200);
        return (await submitted.response.json()) as { redirect_uri?: string };
    }

    function redeem(code: string, verifier: string) {
        return request(app.getHttpServer())
            .post(`${base()}/token`)
            .set("Authorization", basic())
            .type("form")
            .send({
                grant_type: "authorization_code",
                code,
                redirect_uri: REDIRECT,
                code_verifier: verifier,
            });
    }

    async function verifyIdToken(idToken: string) {
        const jwks = await request(app.getHttpServer())
            .get(`${base()}/jwks`)
            .expect(200);
        const { payload, protectedHeader } = await jwtVerify(
            idToken,
            createLocalJWKSet(jwks.body),
            { issuer: issuer(), audience: clientId },
        );
        expect(protectedHeader.alg).toBe("ES256");
        return payload;
    }

    function codeFrom(location: string): string {
        const url = new URL(location);
        expect(url.origin + url.pathname).toBe(REDIRECT);
        expect(url.searchParams.get("state")).toBe("state-1");
        expect(url.searchParams.get("iss")).toBe(issuer());
        return url.searchParams.get("code")!;
    }

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        privateIssuerKey = ctx.privateIssuerKey;
        issuerCertChain = ctx.issuerCertChain;
        statusListService = ctx.statusListService;
        wallet = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    test("the provider is offered only once the tenant has a client", async () => {
        await request(app.getHttpServer())
            .get(`${base()}/.well-known/openid-configuration`)
            .expect(404);
        await request(app.getHttpServer()).get(`${base()}/jwks`).expect(404);
    });

    test("refuses a client with an HTTP redirect URI or an unknown config", async () => {
        await request(app.getHttpServer())
            .post("/verifier/oidc-clients")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ name: "Bad", redirectUris: ["http://rp.example.com/cb"] })
            .expect(400);
        await request(app.getHttpServer())
            .post("/verifier/oidc-clients")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                name: "Bad",
                redirectUris: [REDIRECT],
                scopes: [{ scope: "pid", presentationConfigId: "missing" }],
            })
            .expect(400);
    });

    test("creates a client and returns its secret once", async () => {
        const created = await request(app.getHttpServer())
            .post("/verifier/oidc-clients")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                name: "Customer Portal",
                redirectUris: [REDIRECT],
                scopes: [{ scope: "pid", presentationConfigId: "pid-no-hook" }],
            })
            .expect(201);
        clientId = created.body.id;
        clientSecret = created.body.clientSecret;
        expect(created.body.profile).toBe("secure");
        expect(created.body.issuer).toBe(issuer());
        expect(created.body.secrets).toHaveLength(1);
        expect(JSON.stringify(created.body.secrets)).not.toContain("hash");

        const fetched = await request(app.getHttpServer())
            .get(`/verifier/oidc-clients/${clientId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(fetched.body.clientSecret).toBeUndefined();
    });

    test("publishes the discovery document", async () => {
        const discovery = await request(app.getHttpServer())
            .get(`${base()}/.well-known/openid-configuration`)
            .expect(200);
        expect(discovery.body).toMatchObject({
            issuer: issuer(),
            authorization_endpoint: `${issuer()}/authorize`,
            token_endpoint: `${issuer()}/token`,
            pushed_authorization_request_endpoint: `${issuer()}/par`,
            jwks_uri: `${issuer()}/jwks`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            id_token_signing_alg_values_supported: ["ES256"],
        });
    });

    test("PAR refuses a wrong secret and extra scopes", async () => {
        const { challenge } = pkce();
        const wrong = await request(app.getHttpServer())
            .post(`${base()}/par`)
            .set("Authorization", basic(clientId, "wrong"))
            .type("form")
            .send({ response_type: "code" })
            .expect(401);
        expect(wrong.body.error).toBe("invalid_client");
        expect(wrong.headers["www-authenticate"]).toContain("Basic");

        const scopes = await request(app.getHttpServer())
            .post(`${base()}/par`)
            .set("Authorization", basic())
            .type("form")
            .send({
                response_type: "code",
                redirect_uri: REDIRECT,
                scope: "openid profile email",
                code_challenge: challenge,
                code_challenge_method: "S256",
            })
            .expect(400);
        expect(scopes.body.error).toBe("invalid_scope");
    });

    test("a secure client cannot skip the push", async () => {
        const { challenge } = pkce();
        const res = await request(app.getHttpServer())
            .get(`${base()}/authorize`)
            .query({
                client_id: clientId,
                response_type: "code",
                redirect_uri: REDIRECT,
                scope: "openid pid",
                code_challenge: challenge,
                code_challenge_method: "S256",
            })
            .expect(400);
        expect(res.headers["content-type"]).toContain("text/html");
    });

    test("same device: the wallet returns the holder and the client gets an ID token", async () => {
        const { verifier, cookie, sameDevice } = await startSignIn();
        const { redirect_uri } = await present(sameDevice);
        expect(redirect_uri).toContain("/callback");
        expect(redirect_uri).toContain("response_code=");

        // The wallet's redirect in another browser (no cookie) cannot finish.
        const elsewhere = await request(app.getHttpServer())
            .get(local(redirect_uri!))
            .expect(200);
        expect(elsewhere.text).toContain("Return to your browser");

        const callback = await request(app.getHttpServer())
            .get(local(redirect_uri!))
            .set("Cookie", cookie)
            .expect(303);
        const code = codeFrom(callback.headers.location);

        const tokens = await redeem(code, verifier).expect(200);
        expect(tokens.headers["cache-control"]).toBe("no-store");
        expect(tokens.body).toMatchObject({
            token_type: "Bearer",
            scope: "openid pid",
        });
        const claims = await verifyIdToken(tokens.body.id_token);
        expect(claims).toMatchObject({
            nonce: "nonce-1",
            acr: ACR_SAME_DEVICE,
        });
        expect(typeof claims.sub).toBe("string");
        expect(typeof claims.auth_time).toBe("number");
        expect(claims.credentials).toEqual([
            expect.objectContaining({ id: "pid" }),
        ]);

        const replay = await redeem(code, verifier).expect(400);
        expect(replay.body.error).toBe("invalid_grant");
    });

    test("cross device: the starting browser finishes after the wallet presented", async () => {
        const { verifier, cookie, pagePath, sameDevice } = await startSignIn();
        // The QR code's request is the same one with /no-redirect.
        const crossDevice = sameDevice.replace(
            encodeURIComponent("/oid4vp/request"),
            encodeURIComponent("/oid4vp/request/no-redirect"),
        );
        const { redirect_uri } = await present(crossDevice);
        expect(redirect_uri).toBeUndefined();

        const status = await request(app.getHttpServer())
            .get(`${pagePath}/status`)
            .set("Cookie", cookie)
            .expect(200);
        expect(status.body).toEqual({ state: "ready" });

        await request(app.getHttpServer())
            .get(`${pagePath}/complete`)
            .expect(400);
        const foreign = await request(app.getHttpServer())
            .get(`${pagePath}/status`)
            .expect(409);
        expect(foreign.body).toEqual({ error: "sign_in_not_usable" });

        const complete = await request(app.getHttpServer())
            .get(`${pagePath}/complete`)
            .set("Cookie", cookie)
            .expect(303);
        const tokens = await redeem(
            codeFrom(complete.headers.location),
            verifier,
        ).expect(200);
        expect((await verifyIdToken(tokens.body.id_token)).acr).toBe(
            ACR_CROSS_DEVICE,
        );
    });

    test("acr_values with only same-device refuses a cross-device presentation", async () => {
        const { cookie, pagePath, sameDevice } = await startSignIn({
            acr_values: ACR_SAME_DEVICE,
        });
        await present(
            sameDevice.replace(
                encodeURIComponent("/oid4vp/request"),
                encodeURIComponent("/oid4vp/request/no-redirect"),
            ),
        );
        const complete = await request(app.getHttpServer())
            .get(`${pagePath}/complete`)
            .set("Cookie", cookie)
            .expect(303);
        const url = new URL(complete.headers.location);
        expect(url.searchParams.get("error")).toBe("access_denied");
        expect(url.searchParams.get("state")).toBe("state-1");
    });

    test("the token endpoint checks PKCE", async () => {
        const { cookie, sameDevice } = await startSignIn();
        const { redirect_uri } = await present(sameDevice);
        const callback = await request(app.getHttpServer())
            .get(local(redirect_uri!))
            .set("Cookie", cookie)
            .expect(303);
        const res = await redeem(
            codeFrom(callback.headers.location),
            "a-different-verifier-of-sufficient-length-0000",
        ).expect(400);
        expect(res.body.error).toBe("invalid_grant");
    });

    test("rotates secrets: at most two, never none", async () => {
        const auth = `Bearer ${authToken}`;
        const client = await request(app.getHttpServer())
            .get(`/verifier/oidc-clients/${clientId}`)
            .set("Authorization", auth)
            .expect(200);
        const oldSecretId = client.body.secrets[0].id;
        expect(client.body.secrets[0].lastUsedAt).toBeTruthy();

        const added = await request(app.getHttpServer())
            .post(`/verifier/oidc-clients/${clientId}/secrets`)
            .set("Authorization", auth)
            .expect(201);
        await request(app.getHttpServer())
            .post(`/verifier/oidc-clients/${clientId}/secrets`)
            .set("Authorization", auth)
            .expect(409);

        // Both secrets work during the rotation.
        const { challenge } = pkce();
        const par = (secret: string) =>
            request(app.getHttpServer())
                .post(`${base()}/par`)
                .set("Authorization", basic(clientId, secret))
                .type("form")
                .send({
                    response_type: "code",
                    redirect_uri: REDIRECT,
                    scope: "openid pid",
                    code_challenge: challenge,
                    code_challenge_method: "S256",
                });
        await par(clientSecret).expect(201);
        await par(added.body.clientSecret).expect(201);

        await request(app.getHttpServer())
            .delete(`/verifier/oidc-clients/${clientId}/secrets/${oldSecretId}`)
            .set("Authorization", auth)
            .expect(204);
        await par(clientSecret).expect(401);
        await request(app.getHttpServer())
            .delete(
                `/verifier/oidc-clients/${clientId}/secrets/${added.body.id}`,
            )
            .set("Authorization", auth)
            .expect(409);
        clientSecret = added.body.clientSecret;
    });

    test("a basic client may send the parameters to the authorization endpoint", async () => {
        await request(app.getHttpServer())
            .patch(`/verifier/oidc-clients/${clientId}`)
            .set("Authorization", `Bearer ${authToken}`)
            .send({ profile: "basic" })
            .expect(200);
        const { challenge } = pkce();
        const params = {
            client_id: clientId,
            response_type: "code",
            redirect_uri: REDIRECT,
            scope: "openid pid",
            state: "state-1",
            code_challenge: challenge,
            code_challenge_method: "S256",
        };
        await request(app.getHttpServer())
            .get(`${base()}/authorize`)
            .query(params)
            .expect(303);

        // An invalid request goes back to the client with its state.
        const invalid = await request(app.getHttpServer())
            .get(`${base()}/authorize`)
            .query({ ...params, scope: "openid profile email" })
            .expect(303);
        const url = new URL(invalid.headers.location);
        expect(url.origin + url.pathname).toBe(REDIRECT);
        expect(url.searchParams.get("error")).toBe("invalid_scope");
        expect(url.searchParams.get("state")).toBe("state-1");

        // An unregistered redirect URI is never redirected to.
        await request(app.getHttpServer())
            .get(`${base()}/authorize`)
            .query({ ...params, redirect_uri: "https://attacker.example/cb" })
            .expect(400);
    });

    test("an expired secret is refused, and deleting the client ends the provider", async () => {
        const auth = `Bearer ${authToken}`;
        const client = await request(app.getHttpServer())
            .get(`/verifier/oidc-clients/${clientId}`)
            .set("Authorization", auth)
            .expect(200);
        await request(app.getHttpServer())
            .patch(
                `/verifier/oidc-clients/${clientId}/secrets/${client.body.secrets[0].id}`,
            )
            .set("Authorization", auth)
            .send({ expiresAt: new Date(Date.now() - 1000).toISOString() })
            .expect(200);
        const expired = await request(app.getHttpServer())
            .post(`${base()}/token`)
            .set("Authorization", basic())
            .type("form")
            .send({ grant_type: "authorization_code", code: "x" })
            .expect(401);
        expect(expired.body.error).toBe("invalid_client");

        await request(app.getHttpServer())
            .delete(`/verifier/oidc-clients/${clientId}`)
            .set("Authorization", auth)
            .expect(204);
        await request(app.getHttpServer())
            .get(`/verifier/oidc-clients/${clientId}`)
            .set("Authorization", auth)
            .expect(404);
        await request(app.getHttpServer())
            .get(`${base()}/.well-known/openid-configuration`)
            .expect(404);
    });

    test("client management needs a management token", async () => {
        await request(app.getHttpServer())
            .get(`/verifier/oidc-clients/${clientId}`)
            .expect(401);
    });
});
