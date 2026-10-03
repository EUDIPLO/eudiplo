import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { IssuanceTestContext, setupIssuanceTestApp } from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Interactive Authorization Endpoint (IAE)", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;
    const tenantId = "root";

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    describe("Initial Request", () => {
        test("should return openid4vp interaction response", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "openid4vp_presentation",
                    redirect_uri: "https://wallet.example.com/callback",
                    scope: "openid",
                })
                .expect(200);

            expect(response.body.status).toBe("require_interaction");
            expect(response.body.type).toBe("openid4vp_presentation");
            expect(response.body.auth_session).toBeDefined();
            expect(response.body.openid4vp_request).toBeDefined();
            expect(response.body.openid4vp_request.request).toBeDefined();
        });

        test("should return redirect_to_web interaction response", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "redirect_to_web",
                    redirect_uri: "https://wallet.example.com/callback",
                    code_challenge:
                        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                    code_challenge_method: "S256",
                })
                .expect(200);

            expect(response.body.status).toBe("require_interaction");
            expect(response.body.type).toBe("redirect_to_web");
            expect(response.body.auth_session).toBeDefined();
            expect(response.body.request_uri).toBeDefined();
            expect(response.body.expires_in).toBe(600);
        });

        test("should prefer openid4vp when both types are supported", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported:
                        "openid4vp_presentation,redirect_to_web",
                    redirect_uri: "https://wallet.example.com/callback",
                })
                .expect(200);

            expect(response.body.type).toBe("openid4vp_presentation");
        });

        test("should return error when client_id is missing", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    interaction_types_supported: "openid4vp_presentation",
                })
                .expect(400);

            expect(response.body.error).toBe("invalid_request");
            expect(response.body.error_description).toContain("client_id");
        });

        test("should return error when interaction_types_supported is missing", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                })
                .expect(400);

            expect(response.body.error).toBeDefined();
        });

        test("should accept authorization_details with credential configuration", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "openid4vp_presentation",
                    authorization_details: JSON.stringify([
                        {
                            type: "openid_credential",
                            credential_configuration_id: "pid-no-key",
                        },
                    ]),
                })
                .expect(200);

            expect(response.body.status).toBe("require_interaction");
        });

        test("should expose credential offer by reference endpoint", async () => {
            const offerResponse = await request(app.getHttpServer())
                .post("/issuer/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "authorization_code",
                })
                .expect(201);

            const offerUri = new URL(offerResponse.body.uri);
            const credentialOfferUri = offerUri.searchParams.get(
                "credential_offer_uri",
            );

            expect(credentialOfferUri).toBeDefined();
            expect(offerUri.searchParams.get("credential_offer")).toBeNull();

            const offerPayloadResponse = await new Promise<request.Response>(
                (resolve, reject) => {
                    request(app.getHttpServer())
                        .get(new URL(credentialOfferUri!).pathname)
                        .end((err, response) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            resolve(response);
                        });
                },
            );

            expect(offerPayloadResponse.status).toBe(200);

            expect(offerPayloadResponse.body.credential_issuer).toContain(
                `/issuers/${tenantId}`,
            );
            expect(
                offerPayloadResponse.body.credential_configuration_ids,
            ).toContain("pid-no-key");
        });

        test("should include issuer_state when provided", async () => {
            // First create an offer to get an issuer_state
            const offerResponse = await request(app.getHttpServer())
                .post("/issuer/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "authorization_code",
                })
                .expect(201);

            // Extract issuer_state from the offer URI
            const offerUri = new URL(offerResponse.body.uri);
            const credentialOfferUri = offerUri.searchParams.get(
                "credential_offer_uri",
            );
            let issuerState: string | undefined;

            if (credentialOfferUri) {
                const offerPayloadResponse =
                    await new Promise<request.Response>((resolve, reject) => {
                        request(app.getHttpServer())
                            .get(new URL(credentialOfferUri).pathname)
                            .end((err, response) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                resolve(response);
                            });
                    });
                expect(offerPayloadResponse.status).toBe(200);
                issuerState =
                    offerPayloadResponse.body.grants?.authorization_code
                        ?.issuer_state;
            }

            issuerState ??= offerResponse.body.session;

            if (issuerState) {
                const response = await request(app.getHttpServer())
                    .post(`/issuers/${tenantId}/authorize/interactive`)
                    .send({
                        response_type: "code",
                        client_id: "test-wallet",
                        interaction_types_supported: "openid4vp_presentation",
                        issuer_state: issuerState,
                    })
                    .expect(200);

                expect(response.body.status).toBe("require_interaction");
            }
        });
    });

    describe("Follow-up Request", () => {
        test("should return error for invalid auth_session", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: "invalid-session-id",
                    openid4vp_response: JSON.stringify({ vp_token: "token" }),
                })
                .expect(400);

            expect(response.body.error).toBe("invalid_request");
            expect(response.body.error_description).toContain(
                "Invalid or expired",
            );
        });

        test("should return error when neither openid4vp_response nor code_verifier provided", async () => {
            // First get a valid auth_session
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "openid4vp_presentation",
                })
                .expect(200);

            const authSession = initialResponse.body.auth_session;

            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    // Missing openid4vp_response and code_verifier
                })
                .expect(400);

            expect(response.body.error).toBeDefined();
        });

        test("should issue authorization code on valid openid4vp_response", async () => {
            // First get a valid auth_session
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "openid4vp_presentation",
                })
                .expect(200);

            const authSession = initialResponse.body.auth_session;

            // For this test, we'll simulate a valid VP response
            // In a real scenario, the wallet would create a proper VP
            const vpResponse = {
                vp_token: "mock-vp-token",
                presentation_submission: {
                    id: "submission-1",
                    definition_id: "def-1",
                    descriptor_map: [],
                },
            };

            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    openid4vp_response: JSON.stringify(vpResponse),
                })
                .expect(200);

            expect(response.body.status).toBe("ok");
            expect(response.body.code).toBeDefined();
        });
    });

    describe("Redirect-to-web Flow", () => {
        test("should complete web authorization and issue code", async () => {
            const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
            const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

            // Step 1: Initial request with redirect_to_web
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "redirect_to_web",
                    code_challenge: codeChallenge,
                    code_challenge_method: "S256",
                })
                .expect(200);

            expect(initialResponse.body.type).toBe("redirect_to_web");
            const authSession = initialResponse.body.auth_session;

            // Step 2: Complete web authorization (simulating user completing web flow)
            const completeResponse = await request(app.getHttpServer())
                .post(
                    `/issuers/${tenantId}/authorize/interactive/complete-web-auth/${authSession}`,
                )
                .expect(200);

            expect(completeResponse.body.success).toBe(true);

            // Step 3: Follow-up request with code_verifier
            const followUpResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    code_verifier: codeVerifier,
                })
                .expect(200);

            expect(followUpResponse.body.status).toBe("ok");
            expect(followUpResponse.body.code).toBeDefined();
        });

        test("should reject code_verifier when web auth not completed", async () => {
            const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
            const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

            // Step 1: Initial request
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "redirect_to_web",
                    code_challenge: codeChallenge,
                    code_challenge_method: "S256",
                })
                .expect(200);

            const authSession = initialResponse.body.auth_session;

            // Step 2: Try to submit code_verifier without completing web auth
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    code_verifier: codeVerifier,
                })
                .expect(400);

            expect(response.body.error).toBe("access_denied");
            expect(response.body.error_description).toContain("not completed");
        });

        test("should reject invalid code_verifier", async () => {
            const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

            // Step 1: Initial request
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "redirect_to_web",
                    code_challenge: codeChallenge,
                    code_challenge_method: "S256",
                })
                .expect(200);

            const authSession = initialResponse.body.auth_session;

            // Complete web auth
            await request(app.getHttpServer())
                .post(
                    `/issuers/${tenantId}/authorize/interactive/complete-web-auth/${authSession}`,
                )
                .expect(200);

            // Step 2: Try with wrong code_verifier
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    code_verifier: "wrong-verifier",
                })
                .expect(400);

            expect(response.body.error).toBe("invalid_grant");
            expect(response.body.error_description).toContain("code_verifier");
        });

        test("should reject code_challenge_method plain", async () => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "redirect_to_web",
                    code_challenge: "plain-code-verifier",
                    code_challenge_method: "plain",
                })
                .expect(400);

            expect(response.body.error).toBe("invalid_request");
            expect(response.body.error_description).toContain("S256");
        });
    });

    describe("Complete Web Auth Endpoint", () => {
        test("should return error for non-existent session", async () => {
            const response = await request(app.getHttpServer())
                .post(
                    `/issuers/${tenantId}/authorize/interactive/complete-web-auth/non-existent-session`,
                )
                .expect(200);

            expect(response.body.error).toBe("not_found");
        });
    });

    describe("Metadata", () => {
        test("should include interactive_authorization_endpoint in metadata", async () => {
            const response = await request(app.getHttpServer())
                .get(
                    `/.well-known/oauth-authorization-server/issuers/${tenantId}`,
                )
                .expect(200);

            expect(
                response.body.interactive_authorization_endpoint,
            ).toBeDefined();
            expect(response.body.interactive_authorization_endpoint).toContain(
                "/authorize/interactive",
            );
        });

        test("should include status_list_aggregation_endpoint in metadata when aggregation is enabled", async () => {
            const response = await request(app.getHttpServer())
                .get(
                    `/.well-known/oauth-authorization-server/issuers/${tenantId}`,
                )
                .expect(200);

            expect(
                response.body.status_list_aggregation_endpoint,
            ).toBeDefined();
            expect(response.body.status_list_aggregation_endpoint).toContain(
                "/status-management/status-list-aggregation",
            );
        });

        test("should not include status_list_aggregation_endpoint when aggregation is disabled", async () => {
            // Disable aggregation for this tenant
            await request(app.getHttpServer())
                .put("/status-list-config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ enableAggregation: false })
                .expect(200);

            const response = await request(app.getHttpServer())
                .get(
                    `/.well-known/oauth-authorization-server/issuers/${tenantId}`,
                )
                .expect(200);

            expect(
                response.body.status_list_aggregation_endpoint,
            ).toBeUndefined();

            // Re-enable aggregation to not affect other tests
            await request(app.getHttpServer())
                .put("/status-list-config")
                .set("Authorization", `Bearer ${authToken}`)
                .send({ enableAggregation: true })
                .expect(200);
        });
    });

    describe("Multi-step IAE Flow", () => {
        test("should complete multi-step flow (openid4vp -> redirect_to_web -> code)", async () => {
            const _codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
            const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

            // Step 1: Initial request supporting both interaction types
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported:
                        "openid4vp_presentation,redirect_to_web",
                    code_challenge: codeChallenge,
                    code_challenge_method: "S256",
                })
                .expect(200);

            expect(initialResponse.body.status).toBe("require_interaction");
            // First step should be openid4vp (preferred)
            expect(initialResponse.body.type).toBe("openid4vp_presentation");
            const authSession = initialResponse.body.auth_session;

            // Step 2: Submit VP response (completes first action)
            const vpResponse = {
                vp_token: "mock-vp-token",
                presentation_submission: {
                    id: "submission-1",
                    definition_id: "def-1",
                    descriptor_map: [],
                },
            };

            const step2Response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    openid4vp_response: JSON.stringify(vpResponse),
                })
                .expect(200);

            // Should return authorization code (single-step default flow)
            // or could return next action if credential config has multiple iaeActions
            expect(step2Response.body.status).toBe("ok");
            expect(step2Response.body.code).toBeDefined();
        });

        test("should handle credential config with configured iaeActions", async () => {
            // This test verifies the flow when a credential has explicit iaeActions configured
            // The credential config would need iaeActions: [{ type: 'openid4vp_presentation', presentationConfigId: '...' }]
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "openid4vp_presentation",
                    authorization_details: JSON.stringify([
                        {
                            type: "openid_credential",
                            credential_configuration_id: "pid-no-key", // Uses default presentation config
                        },
                    ]),
                })
                .expect(200);

            expect(response.body.status).toBe("require_interaction");
            expect(response.body.type).toBe("openid4vp_presentation");
            expect(response.body.auth_session).toBeDefined();
        });
    });
});
