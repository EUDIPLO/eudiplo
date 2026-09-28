import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { CryptoKey } from "jose";
import nock from "nock";
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
                nonce: resolved.authorizationRequestPayload.nonce,
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
});
