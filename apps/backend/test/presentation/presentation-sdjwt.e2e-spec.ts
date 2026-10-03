import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import * as x509Lib from "@peculiar/x509";
import { CryptoKey, generateKeyPair } from "jose";
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

describe("Presentation - SD-JWT Credential", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let privateIssuerKey: CryptoKey;
    let issuerCertChain: string[];
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
        privateKey: CryptoKey;
        x5c: string[];
    }) {
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: values.requestId,
            ...(values.webhookUrl && {
                webhook: {
                    url: values.webhookUrl,
                    auth: { type: AuthConfig.NONE },
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

        const x5c = values.x5c;
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
        const submitRes = await client
            .submitOpenid4vpAuthorizationResponse({
                authorizationResponsePayload:
                    authorizationResponse.authorizationResponsePayload,
                authorizationRequestPayload:
                    resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
            })
            .catch((err) => {
                console.error("Error submitting presentation:", err);
                throw err;
            });
        console.log(await submitRes.response.json());

        return { res, submitRes };
    }

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

    test("present sd jwt credential", async () => {
        const { res, submitRes } = await submitPresentation({
            requestId: "pid-no-hook",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);

        const sessionResponse = await request(app.getHttpServer())
            .get(`/session/${res.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(sessionResponse.body.responseEncryptionPrivateJwk).toBeNull();
    });

    test("present sd jwt credential using claim_sets preference order", async () => {
        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "pid-claim-sets",
                description: "PID with alternative claim sets",
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: {
                                vct_values: [
                                    "<TENANT_URL>/credentials-metadata/vct/pid",
                                ],
                            },
                            claims: [
                                { id: "birthdate", path: ["birthdate"] },
                                {
                                    id: "locality",
                                    path: ["address", "locality"],
                                },
                                {
                                    id: "postal_code",
                                    path: ["address", "postal_code"],
                                },
                            ],
                            claim_sets: [
                                ["postal_code"],
                                ["birthdate", "locality"],
                            ],
                        },
                    ],
                },
            })
            .expect(201);

        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-claim-sets",
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
    });

    test("present sd jwt credential with A256GCM encryption", async () => {
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
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

        const x5c = issuerCertChain;
        const vp_token = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
            },
            privateIssuerKey,
            x5c,
            statusListService,
            credentialConfigId,
        );

        // Use A256GCM encryption instead of A128GCM
        const jwt = await encryptVpToken(vp_token, "pid", resolved, "A256GCM");

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

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
    });

    test("handle wallet error response (user_cancelled)", async () => {
        // Create a presentation request to get a session ID
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        };

        const res = await createPresentationRequest(
            app,
            authToken,
            requestBody,
        );

        const sessionId = res.body.session;

        // Simulate wallet sending an error response instead of a VP token
        // Per OID4VP spec section 6.2, wallets can return OAuth 2.0 error responses
        const errorResponse = await request(app.getHttpServer())
            .post(`/presentations/${sessionId}/oid4vp`)
            .trustLocalhost()
            .send({
                error: "access_denied",
                error_description: "User cancelled the presentation request",
                state: sessionId,
            })
            .expect(200); // OID4VP 1.0 §8.2: processed error responses get 200

        // Verify response is empty (no redirect_uri configured)
        expect(errorResponse.body).toEqual({});

        // Verify the session is marked as failed with error reason
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.status).toBe("failed");
        expect(sessionRes.body.errorReason).toContain("Wallet error");
        expect(sessionRes.body.errorReason).toContain("access_denied");
        expect(sessionRes.body.errorReason).toContain(
            "User cancelled the presentation request",
        );
        expect(sessionRes.body.failureCode).toBe("access_denied");
        expect(sessionRes.body.outcome).toMatchObject({
            result: "failed",
            error: "access_denied",
        });
    });

    test("should reject credential signed by untrusted issuer (not in trust list)", async () => {
        // Generate a new key pair that is NOT in the trust list
        const untrustedKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });

        // Generate a self-signed certificate for the untrusted key
        x509Lib.cryptoProvider.set(globalThis.crypto);
        const untrustedCert =
            await x509Lib.X509CertificateGenerator.createSelfSigned({
                serialNumber: "01",
                name: "CN=Untrusted Issuer",
                notBefore: new Date(),
                notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys: {
                    privateKey: untrustedKeyPair.privateKey,
                    publicKey: untrustedKeyPair.publicKey,
                },
            });

        // Convert certificate to base64 for x5c header
        const untrustedCertChain = [untrustedCert.toString("base64")];

        // Create a presentation request
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        };

        const res = await createPresentationRequest(
            app,
            authToken,
            requestBody,
        );

        const sessionId = res.body.session;

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        // Create a credential signed with the UNTRUSTED key
        const vp_token = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
            },
            untrustedKeyPair.privateKey,
            untrustedCertChain,
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

        // Submit the presentation - should fail
        const submitRes = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        // The submission should succeed (200 per OID4VP spec) but session should fail
        expect(submitRes.response.status).toBe(400);

        // Verify the session is marked as failed with trust-related error
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.status).toBe("failed");
        // Error should mention trust chain, signature validation, or untrusted issuer
        // The system may fail at signature verification (when x5c doesn't chain to trust anchor)
        // or at trust list matching - both indicate credential rejection from untrusted source
        expect(sessionRes.body.errorReason).toMatch(
            /trust|chain|no_trusted_entity_match|Invalid.*Signature/i,
        );
        // Classified failures name the failing credential in the outcome.
        expect(sessionRes.body.failureCode).toEqual(expect.any(String));
        expect(sessionRes.body.outcome.credentials).toEqual([
            {
                id: "pid",
                format: "dc+sd-jwt",
                verified: false,
                error: sessionRes.body.failureCode,
                message: sessionRes.body.errorReason,
            },
        ]);
    });
});
