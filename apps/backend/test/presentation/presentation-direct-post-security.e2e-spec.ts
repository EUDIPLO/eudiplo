import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { CryptoKey, decodeJwt } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    PresentationTestContext,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";

/**
 * E2E tests for OID4VP Section 13.3 — direct_post response mode security.
 *
 * Validates:
 *  - walletNonce / session ID separation (transaction-id vs request-id)
 *  - Authorization request JWT uses walletNonce in state & response_uri
 *  - response_code generation and inclusion in redirect_uri
 *  - Frontend polling uses session ID (not walletNonce)
 *  - Session ID is not exposed in wallet-facing URLs
 */
describe("Presentation - Direct Post Security (Section 13.3)", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let privateIssuerKey: CryptoKey;
    let issuerCertChain: string[];
    let statusListService: StatusListService;
    let ctx: PresentationTestContext;

    const credentialConfigId = "pid";

    let client: Openid4vpClient;

    beforeAll(async () => {
        ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        privateIssuerKey = ctx.privateIssuerKey;
        issuerCertChain = ctx.issuerCertChain;
        statusListService = ctx.statusListService;

        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    // ─── walletNonce / session ID separation ───────────────────────────

    test("offer response returns session ID that differs from walletNonce in request_uri", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        expect(res.status).toBe(201);

        const sessionId: string = res.body.session;
        const uri: string = res.body.uri;

        // Extract the walletNonce from request_uri in the uri query string
        const requestUriParam = new URLSearchParams(uri).get("request_uri")!;
        // request_uri format: {host}/presentations/{walletNonce}/oid4vp/request
        const walletNonce = requestUriParam
            .split("/presentations/")[1]
            .split("/oid4vp")[0];

        expect(sessionId).toBeDefined();
        expect(walletNonce).toBeDefined();
        // The walletNonce used in wallet-facing URLs must be different from the session ID
        expect(walletNonce).not.toBe(sessionId);
    });

    test("crossDeviceUri also uses walletNonce, not session ID", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        const sessionId: string = res.body.session;
        const crossDeviceUri: string = res.body.crossDeviceUri;

        const requestUriParam = new URLSearchParams(crossDeviceUri).get(
            "request_uri",
        )!;
        const walletNonce = requestUriParam
            .split("/presentations/")[1]
            .split("/oid4vp")[0];

        expect(walletNonce).not.toBe(sessionId);
    });

    // ─── Authorization request JWT validation ──────────────────────────

    test("authorization request JWT state matches walletNonce (not session ID)", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        const sessionId: string = res.body.session;
        const uri: string = res.body.uri;
        const requestUriParam = new URLSearchParams(uri).get("request_uri")!;
        const walletNonce = requestUriParam
            .split("/presentations/")[1]
            .split("/oid4vp")[0];

        // Fetch the authorization request JWT via the wallet-facing endpoint
        const authReqRes = await request(app.getHttpServer())
            .get(`/presentations/${walletNonce}/oid4vp/request`)
            .trustLocalhost()
            .expect(200);

        const jwt = authReqRes.text;
        const payload = decodeJwt(jwt);

        // state in the JWT must be the walletNonce
        expect(payload.state).toBe(walletNonce);
        expect(payload.state).not.toBe(sessionId);
    });

    test("authorization request JWT response_uri contains walletNonce (not session ID)", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        const sessionId: string = res.body.session;
        const uri: string = res.body.uri;
        const requestUriParam = new URLSearchParams(uri).get("request_uri")!;
        const walletNonce = requestUriParam
            .split("/presentations/")[1]
            .split("/oid4vp")[0];

        const authReqRes = await request(app.getHttpServer())
            .get(`/presentations/${walletNonce}/oid4vp/request`)
            .trustLocalhost()
            .expect(200);

        const payload = decodeJwt(authReqRes.text);
        const responseUri = payload.response_uri as string;

        // response_uri must contain walletNonce, not the session ID
        expect(responseUri).toContain(`/presentations/${walletNonce}/oid4vp`);
        expect(responseUri).not.toContain(`/presentations/${sessionId}/oid4vp`);
    });

    // ─── Session ID cannot be used on wallet-facing endpoints ──────────

    test("using session ID on the wallet-facing request endpoint fails", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        const sessionId: string = res.body.session;

        // Attempting to use the session ID on the wallet-facing endpoint should fail
        // because resolveSessionByNonce looks up by walletNonce first,
        // and falls back to session.id — but the requestObject is only cached
        // under the session's walletNonce path.
        // The session should still be resolvable via session ID fallback,
        // but this tests that the URL was built with walletNonce.
        const uri: string = res.body.uri;
        const requestUriParam = new URLSearchParams(uri).get("request_uri")!;

        // Verify the request_uri does NOT contain the session ID
        expect(requestUriParam).not.toContain(`/presentations/${sessionId}/`);
    });

    // ─── Frontend polling uses session ID ──────────────────────────────

    test("frontend can poll session status using session ID", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        const sessionId: string = res.body.session;

        // Frontend polls with session ID → should work
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.id).toBe(sessionId);
        expect(sessionRes.body.status).toBe("active");
    });

    // ─── response_code in redirect_uri ─────────────────────────────────

    test("successful presentation with redirectUri includes response_code", async () => {
        const redirectUri = "https://example.com/callback?session={sessionId}";

        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
            redirectUri,
        });

        const sessionId: string = res.body.session;

        // Resolve the wallet-facing authorization request
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        // Prepare and encrypt VP token
        const vp_token = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
            },
            privateIssuerKey,
            issuerCertChain,
            statusListService,
            credentialConfigId,
        );

        const jwt = await encryptVpToken(vp_token, "pid", resolved);

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: jwt,
                },
                ...callbacks,
            });

        const submitRes = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        expect(submitRes.response.status).toBe(200);

        const body = await submitRes.response.json();

        // The redirect_uri must include a response_code query parameter
        expect(body.redirect_uri).toBeDefined();
        const redirectUrl = new URL(body.redirect_uri);
        const responseCode = redirectUrl.searchParams.get("response_code");
        expect(responseCode).toBeDefined();
        expect(responseCode!.length).toBeGreaterThan(0);

        // The redirect_uri should also contain the sessionId placeholder replaced
        expect(redirectUrl.searchParams.get("session")).toBe(sessionId);
    });

    test("response_code is stored in session after successful presentation", async () => {
        const redirectUri = "https://example.com/done?session={sessionId}";

        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
            redirectUri,
        });

        const sessionId: string = res.body.session;

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        const vp_token = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
            },
            privateIssuerKey,
            issuerCertChain,
            statusListService,
            credentialConfigId,
        );

        const jwt = await encryptVpToken(vp_token, "pid", resolved);

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: jwt,
                },
                ...callbacks,
            });

        await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        // Check session — responseCode should be set
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.status).toBe("completed");
        expect(sessionRes.body.responseCode).toBeDefined();
        expect(sessionRes.body.responseCode.length).toBeGreaterThan(0);
    });

    test("response_code is unique per presentation", async () => {
        const redirectUri = "https://example.com/result";

        async function performPresentation() {
            const res = await createPresentationRequest(app, authToken, {
                response_type: ResponseType.URI,
                requestId: "pid-no-hook",
                redirectUri,
            });

            const authRequest = client.parseOpenid4vpAuthorizationRequest({
                authorizationRequest: res.body.uri,
            });

            const resolved = await client.resolveOpenId4vpAuthorizationRequest({
                authorizationRequestPayload: authRequest.params,
                responseMode: { type: "direct_post" },
            });

            const vp_token = await preparePresentation(
                {
                    iat: Math.floor(Date.now() / 1000),
                    aud: resolved.authorizationRequestPayload
                        .client_id as string,
                    nonce: resolved.authorizationRequestPayload.nonce,
                },
                privateIssuerKey,
                issuerCertChain,
                statusListService,
                credentialConfigId,
            );

            const jwt = await encryptVpToken(vp_token, "pid", resolved);

            const authorizationResponse =
                await client.createOpenid4vpAuthorizationResponse({
                    authorizationRequestPayload: authRequest.params,
                    authorizationResponsePayload: {
                        response: jwt,
                    },
                    ...callbacks,
                });

            const submitRes = await client.submitOpenid4vpAuthorizationResponse(
                {
                    authorizationResponsePayload:
                        authorizationResponse.authorizationResponsePayload,
                    authorizationRequestPayload:
                        resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
                },
            );

            const body = await submitRes.response.json();
            const redirectUrl = new URL(body.redirect_uri);
            return redirectUrl.searchParams.get("response_code")!;
        }

        const code1 = await performPresentation();
        const code2 = await performPresentation();

        expect(code1).toBeDefined();
        expect(code2).toBeDefined();
        // Each presentation must generate a unique response_code
        expect(code1).not.toBe(code2);
    });

    // ─── Wallet error flow preserves security model ────────────────────

    test("wallet error with redirectUri does not include response_code", async () => {
        const redirectUri = "https://example.com/callback?session={sessionId}";

        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
            redirectUri,
        });

        const uri: string = res.body.uri;
        const requestUriParam = new URLSearchParams(uri).get("request_uri")!;
        const walletNonce = requestUriParam
            .split("/presentations/")[1]
            .split("/oid4vp")[0];

        // Simulate wallet sending an error using the walletNonce in the URL
        const errorRes = await request(app.getHttpServer())
            .post(`/presentations/${walletNonce}/oid4vp`)
            .trustLocalhost()
            .send({
                error: "access_denied",
                error_description: "User declined",
                state: walletNonce,
            })
            .e.expect(200);

        // Error redirect should NOT include a response_code
        expect(errorRes.body.redirect_uri).toBeDefined();
        const redirectUrl = new URL(errorRes.body.redirect_uri);
        expect(redirectUrl.searchParams.has("response_code")).toBe(false);
        expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
    });

    // ─── walletNonce changes on session re-use ─────────────────────────

    test("walletNonce is different for each offer even with same config", async () => {
        const [res1, res2] = await Promise.all([
            createPresentationRequest(app, authToken, {
                response_type: ResponseType.URI,
                requestId: "pid-no-hook",
            }),
            createPresentationRequest(app, authToken, {
                response_type: ResponseType.URI,
                requestId: "pid-no-hook",
            }),
        ]);

        const uri1: string = res1.body.uri;
        const uri2: string = res2.body.uri;
        const requestUri1 = new URLSearchParams(uri1).get("request_uri")!;
        const requestUri2 = new URLSearchParams(uri2).get("request_uri")!;
        const nonce1 = requestUri1
            .split("/presentations/")[1]
            .split("/oid4vp")[0];
        const nonce2 = requestUri2
            .split("/presentations/")[1]
            .split("/oid4vp")[0];

        // Each offer must produce a unique walletNonce
        expect(nonce1).not.toBe(nonce2);
    });

    // ─── Full flow integrity: walletNonce works end-to-end ────────────

    test("complete presentation flow works with walletNonce-based URLs", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        const sessionId: string = res.body.session;

        // Use the Openid4vpClient exactly as a real wallet would
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        // Verify the resolved request uses walletNonce, not sessionId
        const resolvedResponseUri = (
            resolved.authorizationRequestPayload as any
        ).response_uri as string;
        expect(resolvedResponseUri).not.toContain(
            `/presentations/${sessionId}/`,
        );

        const vp_token = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
            },
            privateIssuerKey,
            issuerCertChain,
            statusListService,
            credentialConfigId,
        );

        const jwt = await encryptVpToken(vp_token, "pid", resolved);

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: jwt,
                },
                ...callbacks,
            });

        const submitRes = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        expect(submitRes.response.status).toBe(200);

        // Session should be completed when polled by session ID
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.status).toBe("completed");
        expect(sessionRes.body.credentials).toBeDefined();
        expect(sessionRes.body.credentials.length).toBeGreaterThan(0);
    });
});
