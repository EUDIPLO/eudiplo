import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { CryptoKey } from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import {
    PresentationRequest,
    ResponseType,
} from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { AuthConfig } from "../../src/webhook/webhook.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    PresentationTestContext,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";

describe("Presentation - Webhook Integration", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let privateIssuerKey: CryptoKey;
    let issuerCert: string;
    let statusListService: StatusListService;
    let ctx: PresentationTestContext;

    const credentialConfigId = "pid";

    let client: Openid4vpClient;

    /**
     * Helper function to submit a complete presentation flow
     */
    async function submitPresentation(values: {
        requestId: string;
        credentialId: string;
        webhookUrl?: string;
        includeRawTokensFor?: string[];
        privateKey: CryptoKey;
        issuerCert: string;
        /** Overrides the key-binding nonce, e.g. to make verification fail. */
        nonce?: string;
    }) {
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: values.requestId,
            ...(values.webhookUrl && {
                webhook: {
                    url: values.webhookUrl,
                    auth: { type: AuthConfig.NONE },
                    includeRawTokensFor: values.includeRawTokensFor,
                },
            }),
        };

        const res = await createPresentationRequest(
            app,
            authToken,
            requestBody,
        );

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        const x5c = [
            values.issuerCert
                .replace("-----BEGIN CERTIFICATE-----", "")
                .replace("-----END CERTIFICATE-----", "")
                .replaceAll(/\r?\n|\r/g, ""),
        ];
        const vp_token = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce:
                    values.nonce ?? resolved.authorizationRequestPayload.nonce,
            },
            values.privateKey,
            x5c,
            statusListService,
            credentialConfigId,
        );

        const jwt = await encryptVpToken(
            vp_token,
            values.credentialId || "pid",
            resolved,
        );

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

        return { res, submitRes };
    }

    beforeAll(async () => {
        ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        privateIssuerKey = ctx.privateIssuerKey;
        issuerCert = ctx.issuerCert;
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

    test("webhook in config", async () => {
        // Setup webhook mock with expectations
        nock("http://localhost:8787")
            .post("/consume", (body) => {
                expect(body).toBeDefined();
                expect(body.session).toBeDefined();
                expect(body.status).toBe("completed");
                expect(body.outcome).toEqual({
                    result: "success",
                    credentials: [{ id: "pid", verified: true }],
                });
                expect(body.credentials).toBeDefined();
                expect(body.credentials[0].id).toBe("pid");
                expect(body.credentials[0].values).toBeDefined();
                return true;
            })
            .reply(200);

        const { submitRes } = await submitPresentation({
            requestId: "pid",
            privateKey: privateIssuerKey,
            credentialId: "pid",
            issuerCert,
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
        expect(nock.isDone()).toBe(true);
    });

    test("passed webhook", async () => {
        // Setup webhook mock with expectations
        nock("http://localhost:8787")
            .post("/custom", (body) => {
                expect(body).toBeDefined();
                expect(body.session).toBeDefined();
                expect(body.credentials).toBeDefined();
                expect(body.credentials[0].id).toBe("pid");
                expect(body.credentials[0].values).toBeDefined();
                return true;
            })
            .reply(200);

        const { submitRes } = await submitPresentation({
            requestId: "pid",
            privateKey: privateIssuerKey,
            issuerCert,
            credentialId: "pid",
            webhookUrl: "http://localhost:8787/custom",
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
        expect(nock.isDone()).toBe(true);
    });

    test("webhook with raw token pass-through", async () => {
        // Wir erwarten, dass der Webhook-Body jetzt das Feld 'rawToken' enthält
        nock("http://localhost:8787")
            .post("/raw-token-test", (body) => {
                expect(body).toBeDefined();
                expect(body.credentials).toBeDefined();
                expect(body.credentials[0].id).toBe("pid");

                // DAS IST DER ENTSCHEIDENDE CHECK:
                expect(body.credentials[0].rawToken).toBeDefined();
                expect(typeof body.credentials[0].rawToken).toBe("string");

                // Optional: Prüfen, ob es wie ein JWT/JWS aussieht (3 Teile mit Punkt)
                expect(
                    body.credentials[0].rawToken.split(".").length,
                ).toBeGreaterThanOrEqual(2);

                return true;
            })
            .reply(200);

        const { submitRes } = await submitPresentation({
            requestId: "pid",
            privateKey: privateIssuerKey,
            issuerCert,
            credentialId: "pid",
            webhookUrl: "http://localhost:8787/raw-token-test",
            includeRawTokensFor: ["pid"], // Wir fordern das Token für 'pid' an
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
        expect(nock.isDone()).toBe(true);
    });

    test("declined presentation is reported to the webhook", async () => {
        let received: Record<string, unknown> | undefined;
        nock("http://localhost:8787")
            .post("/declined", (body) => {
                received = body;
                return true;
            })
            .reply(200, { redirectUri: "https://rp.example/declined" });

        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid",
            webhook: {
                url: "http://localhost:8787/declined",
                auth: { type: AuthConfig.NONE },
            },
        });
        const sessionId = res.body.session;

        const errorResponse = await request(app.getHttpServer())
            .post(`/presentations/${sessionId}/oid4vp`)
            .trustLocalhost()
            .send({
                error: "access_denied",
                error_description: "User declined",
                state: sessionId,
            })
            .expect(200);

        expect(nock.isDone()).toBe(true);
        // Failure webhooks carry status and outcome, never credentials.
        expect(received).toEqual({
            status: "failed",
            outcome: {
                result: "failed",
                error: "access_denied",
                message: "Wallet error: access_denied: User declined",
            },
            session: sessionId,
            transaction_data: null,
        });
        // The webhook's redirectUri replaces the configured one.
        expect(errorResponse.body).toEqual({
            redirect_uri:
                "https://rp.example/declined?error=access_denied&error_description=User%20declined",
        });
    });

    test("failed verification is reported to the webhook without credentials", async () => {
        let received: Record<string, any> | undefined;
        nock("http://localhost:8787")
            .post("/failed", (body) => {
                received = body;
                return true;
            })
            .reply(200);

        const { res, submitRes } = await submitPresentation({
            requestId: "pid",
            privateKey: privateIssuerKey,
            issuerCert,
            credentialId: "pid",
            webhookUrl: "http://localhost:8787/failed",
            includeRawTokensFor: ["pid"],
            nonce: "not-the-request-nonce",
        });

        expect(submitRes.response.status).toBe(400);
        expect(nock.isDone()).toBe(true);
        expect(received).toMatchObject({
            status: "failed",
            outcome: { result: "failed" },
            session: res.body.session,
        });
        expect(received?.outcome.message).toEqual(expect.any(String));
        expect(received).not.toHaveProperty("credentials");

        // Delivery happens after the failure is recorded on the session.
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${res.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(sessionRes.body.status).toBe("failed");
        expect(sessionRes.body.outcome).toEqual(received?.outcome);
    });

    test("an unreachable failure webhook does not change the session result", async () => {
        nock("http://localhost:8787").post("/broken").reply(500);

        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid",
            webhook: {
                url: "http://localhost:8787/broken",
                auth: { type: AuthConfig.NONE },
            },
        });
        const sessionId = res.body.session;

        await request(app.getHttpServer())
            .post(`/presentations/${sessionId}/oid4vp`)
            .trustLocalhost()
            .send({ error: "access_denied", state: sessionId })
            .expect(200);

        expect(nock.isDone()).toBe(true);
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(sessionRes.body.status).toBe("failed");
        expect(sessionRes.body.failureCode).toBe("access_denied");
    });
});
