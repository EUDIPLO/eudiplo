import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Openid4vpClient } from "@openid4vc/openid4vp";
import { CryptoKey, generateKeyPair, importJWK } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { DataSource } from "typeorm";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyChainService } from "../../src/crypto/key/key-chain.service.js";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { Session } from "../../src/session/entities/session.entity.js";
import {
    callbacks,
    createTestFetch,
    encryptVpToken,
    getToken,
    IssuanceTestContext,
    preparePresentation,
    readConfig,
    setupIssuanceTestApp,
} from "../utils.js";

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
    /** PKCE with S256 is required on every initial request. */
    const pkce = {
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
    };

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    /** The issuer's backend completes the web interaction with a management token. */
    const completeWebAuth = (authSession: string, token = authToken) =>
        request(app.getHttpServer())
            .post(
                `/issuers/${tenantId}/authorize/interactive/complete-web-auth/${authSession}`,
            )
            .set("Authorization", `Bearer ${token}`);

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
                    ...pkce,
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
                    ...pkce,
                })
                .expect(200);

            expect(response.body.type).toBe("openid4vp_presentation");
        });

        test.each([
            [{}, "code_challenge"],
            [{ code_challenge: pkce.code_challenge }, "S256"],
            [
                {
                    code_challenge:
                        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
                    code_challenge_method: "plain",
                },
                "S256",
            ],
        ])(
            "should return error without an S256 code_challenge (%o)",
            async (challenge, description) => {
                const response = await request(app.getHttpServer())
                    .post(`/issuers/${tenantId}/authorize/interactive`)
                    .send({
                        response_type: "code",
                        client_id: "test-wallet",
                        interaction_types_supported: "openid4vp_presentation",
                        ...challenge,
                    })
                    .expect(400);

                expect(response.body.error).toBe("invalid_request");
                expect(response.body.error_description).toContain(description);
            },
        );

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
                    ...pkce,
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
                        ...pkce,
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
                    ...pkce,
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

        test("should not issue a code for an unverified openid4vp_response", async () => {
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "openid4vp_presentation",
                    ...pkce,
                })
                .expect(200);

            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: initialResponse.body.auth_session,
                    openid4vp_response: JSON.stringify({
                        vp_token: "mock-vp-token",
                    }),
                })
                .expect(400);

            expect(response.body.error).toBe("access_denied");
            expect(response.body.code).toBeUndefined();
        });

        test("should not complete an openid4vp_presentation step with a code_verifier", async () => {
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "openid4vp_presentation",
                    ...pkce,
                })
                .expect(200);
            const authSession = initialResponse.body.auth_session;

            // Neither the wallet nor the backend can turn the presentation
            // step into a completed web interaction.
            const completed = await completeWebAuth(authSession).expect(200);
            expect(completed.body.error).toBe("not_found");
            const response = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    code_verifier:
                        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
                })
                .expect(400);

            expect(response.body.error).toBe("invalid_request");
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
            const completeResponse =
                await completeWebAuth(authSession).expect(200);

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
            await completeWebAuth(authSession).expect(200);

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

    describe("Token endpoint", () => {
        const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

        /** Completes an IAE flow for a new authorization code offer and returns the code. */
        async function issueIaeCode(): Promise<string> {
            return (await issueIaeCodeForOffer()).code;
        }

        async function issueIaeCodeForOffer(): Promise<{
            code: string;
            offerSession: string;
        }> {
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

            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "redirect_to_web",
                    issuer_state: offerResponse.body.session,
                    code_challenge: codeChallenge,
                    code_challenge_method: "S256",
                })
                .expect(200);
            await completeWebAuth(initialResponse.body.auth_session).expect(
                200,
            );

            const codeResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: initialResponse.body.auth_session,
                    code_verifier: codeVerifier,
                })
                .expect(200);

            expect(codeResponse.body.code).toBeDefined();
            return {
                code: codeResponse.body.code,
                offerSession: offerResponse.body.session,
            };
        }

        const redeem = (code: string, verifier?: string) =>
            request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/token`)
                .type("form")
                .send({
                    grant_type: "authorization_code",
                    code,
                    client_id: "test-wallet",
                    ...(verifier && { code_verifier: verifier }),
                });

        test("rejects an IAE authorization code without code_verifier", async () => {
            const response = await redeem(await issueIaeCode()).expect(400);

            expect(response.body.error).toBe("invalid_grant");
        });

        test("rejects an IAE authorization code with a wrong code_verifier", async () => {
            const response = await redeem(
                await issueIaeCode(),
                "wrong-code-verifier-wrong-code-verifier-wrong",
            ).expect(400);

            expect(response.body.error).toBe("invalid_grant");
        });

        test("redeems an IAE authorization code with the matching code_verifier", async () => {
            const response = await redeem(
                await issueIaeCode(),
                codeVerifier,
            ).expect(200);

            expect(response.body.access_token).toBeDefined();
        });

        test("rejects an expired IAE authorization code", async () => {
            const { code, offerSession } = await issueIaeCodeForOffer();
            // IAE codes live as long as authorization endpoint codes (60 s).
            await app
                .get(DataSource)
                .getRepository(Session)
                .update(offerSession, {
                    authorization_code_expires_at: new Date(Date.now() - 1),
                });

            const response = await redeem(code, codeVerifier).expect(400);
            expect(response.body.error).toBe("invalid_grant");
        });
    });

    describe("Complete Web Auth Endpoint", () => {
        const startWebStep = () =>
            request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported: "redirect_to_web",
                    ...pkce,
                })
                .expect(200)
                .then((response) => response.body.auth_session as string);

        test("should return error for non-existent session", async () => {
            const response = await completeWebAuth(
                "00000000-0000-4000-8000-000000000000",
            ).expect(200);

            expect(response.body.error).toBe("not_found");
        });

        test("rejects a request without management token", async () => {
            const authSession = await startWebStep();

            await request(app.getHttpServer())
                .post(
                    `/issuers/${tenantId}/authorize/interactive/complete-web-auth/${authSession}`,
                )
                .expect(401);
            await completeWebAuth(authSession, "not-a-token").expect(401);

            // The web step stays open, so the wallet cannot finish it.
            const followUp = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    code_verifier:
                        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
                })
                .expect(400);
            expect(followUp.body.error).toBe("access_denied");
        });

        test("rejects a management token of another tenant", async () => {
            const authSession = await startWebStep();
            const otherTenantToken = await getToken(
                app,
                ctx.clientId,
                ctx.clientSecret,
                "iae-other-tenant",
            );

            await completeWebAuth(authSession, otherTenantToken).expect(403);
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

    describe("OpenID4VP presentation step", () => {
        const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let client: Openid4vpClient;
        let issuerKey: CryptoKey;
        let issuerCertChain: string[];

        beforeAll(async () => {
            const configFolder = resolve(__dirname + "/../fixtures");
            await request(app.getHttpServer())
                .post("/trust-list")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(
                    readConfig<TrustListCreateDto>(
                        join(configFolder, "haip/trust-lists/pid-tl.json"),
                    ),
                )
                .expect(201);

            // The trust list lists the issuer of the attestation key chain.
            const attestation = await app
                .get(KeyChainService)
                .getEntity(
                    tenantId,
                    readConfig<KeyChainImportDto>(
                        join(configFolder, "haip/key-chains/attestation.json"),
                    ).id!,
                );
            issuerKey = (await importJWK(attestation.activeJwk, "ES256", {
                extractable: true,
            })) as CryptoKey;
            issuerCertChain = (
                attestation.activeCertificate.match(
                    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
                ) ?? []
            ).map((pem) =>
                pem
                    .replace("-----BEGIN CERTIFICATE-----", "")
                    .replace("-----END CERTIFICATE-----", "")
                    .replaceAll(/\r?\n|\r/g, ""),
            );

            const host = app
                .get(ConfigService)
                .getOrThrow<string>("PUBLIC_URL");
            client = new Openid4vpClient({
                callbacks: {
                    ...callbacks,
                    fetch: createTestFetch(app, () => host),
                },
            });
        });

        /**
         * Starts the presentation step for a new authorization code offer
         * and resolves its request like a wallet.
         */
        async function startPresentationStep() {
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
            const initialResponse = await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    response_type: "code",
                    client_id: "test-wallet",
                    interaction_types_supported:
                        "openid4vp_presentation,redirect_to_web",
                    issuer_state: offerResponse.body.session,
                    ...pkce,
                })
                .expect(200);
            expect(initialResponse.body.type).toBe("openid4vp_presentation");

            // `request` carries the parameters of the OpenID4VP request URI.
            const authorizationRequest =
                client.parseOpenid4vpAuthorizationRequest({
                    authorizationRequest: `openid4vp://?${initialResponse.body.openid4vp_request.request}`,
                });
            const resolved = await client.resolveOpenId4vpAuthorizationRequest({
                authorizationRequestPayload: authorizationRequest.params,
                responseMode: { type: "direct_post" },
            });
            return {
                authSession: initialResponse.body.auth_session as string,
                offerSession: offerResponse.body.session as string,
                resolved,
            };
        }

        type Resolved = Awaited<
            ReturnType<typeof startPresentationStep>
        >["resolved"];

        /** Encrypted authorization response with an SD-JWT VC presentation. */
        async function presentationResponse(
            resolved: Resolved,
            options: {
                nonce?: string;
                signingKey?: CryptoKey;
                credentialId?: string;
            } = {},
        ): Promise<Record<string, unknown>> {
            const vpToken = await preparePresentation(
                {
                    iat: Math.floor(Date.now() / 1000),
                    aud: resolved.authorizationRequestPayload
                        .client_id as string,
                    nonce:
                        options.nonce ??
                        resolved.authorizationRequestPayload.nonce,
                },
                options.signingKey ?? issuerKey,
                issuerCertChain,
                app.get(StatusListService),
                "pid-no-key",
            );
            return {
                response: await encryptVpToken(
                    vpToken,
                    options.credentialId ?? "pid",
                    resolved,
                ),
            };
        }

        const submit = (authSession: string, openid4vpResponse: object) =>
            request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/interactive`)
                .send({
                    auth_session: authSession,
                    openid4vp_response: JSON.stringify(openid4vpResponse),
                });

        test("issues a code for a verified presentation and forwards its credentials", async () => {
            const { authSession, offerSession, resolved } =
                await startPresentationStep();
            const openid4vpResponse = await presentationResponse(resolved);

            const response = await submit(
                authSession,
                openid4vpResponse,
            ).expect(200);
            expect(response.body.status).toBe("ok");

            // The auth_session cannot be replayed for another code.
            const replay = await submit(authSession, openid4vpResponse).expect(
                400,
            );
            expect(replay.body.error).toBe("invalid_request");

            await request(app.getHttpServer())
                .post(`/issuers/${tenantId}/authorize/token`)
                .type("form")
                .send({
                    grant_type: "authorization_code",
                    code: response.body.code,
                    client_id: "test-wallet",
                    code_verifier: codeVerifier,
                })
                .expect(200);

            const session = await request(app.getHttpServer())
                .get(`/session/${offerSession}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            expect(session.body.credentials).toEqual([
                expect.objectContaining({ id: "pid" }),
            ]);
        });

        test.each<
            [string, (resolved: Resolved) => Promise<Record<string, unknown>>]
        >([
            [
                "a wrong nonce",
                (resolved) =>
                    presentationResponse(resolved, { nonce: "wrong-nonce" }),
            ],
            [
                "a forged issuer signature",
                async (resolved) =>
                    presentationResponse(resolved, {
                        signingKey: (
                            await generateKeyPair("ES256", {
                                extractable: true,
                            })
                        ).privateKey,
                    }),
            ],
            [
                "a presentation without the requested credential",
                (resolved) =>
                    presentationResponse(resolved, { credentialId: "other" }),
            ],
            [
                "an unencrypted vp_token",
                async () => ({ vp_token: { pid: ["mock-vp-token"] } }),
            ],
            ["an undecryptable response", async () => ({ response: "x.y.z" })],
        ])("rejects %s", async (_, createResponse) => {
            const { authSession, resolved } = await startPresentationStep();

            const response = await submit(
                authSession,
                await createResponse(resolved),
            ).expect(400);
            expect(response.body.error).toBe("access_denied");
            expect(response.body.code).toBeUndefined();
        });

        test("rejects a presentation made for another auth_session", async () => {
            const first = await startPresentationStep();
            const second = await startPresentationStep();

            const response = await submit(
                second.authSession,
                await presentationResponse(first.resolved),
            ).expect(400);
            expect(response.body.error).toBe("access_denied");
        });
    });

    describe("Multi-step IAE Flow", () => {
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
                    ...pkce,
                })
                .expect(200);

            expect(response.body.status).toBe("require_interaction");
            expect(response.body.type).toBe("openid4vp_presentation");
            expect(response.body.auth_session).toBeDefined();
        });
    });
});
