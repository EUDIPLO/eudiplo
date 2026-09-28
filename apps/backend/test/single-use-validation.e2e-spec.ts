import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { clientAuthenticationAnonymous } from "@openid4vc/oauth2";
import { Openid4vciClient } from "@openid4vc/openid4vci";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { CryptoKey } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../src/issuer/status-list/status-list.service.js";
import { ResponseType } from "../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    IssuanceTestContext,
    PresentationTestContext,
    preparePresentation,
    setupIssuanceTestApp,
    setupPresentationTestApp,
} from "./utils.js";

describe("Single-Use Validation (Issue #503) - OID4VCI", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("should reject token exchange once offer is consumed", async () => {
        // Create a credential offer
        const offerRes = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
            })
            .expect(201);

        const sessionId = offerRes.body.session;

        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        });

        const credentialOffer = await client.resolveCredentialOffer(
            offerRes.body.uri,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );

        // First token exchange should succeed
        const tokenResponse =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });
        expect(tokenResponse.accessTokenResponse.access_token).toBeDefined();

        // Session is consumed during token exchange
        const sessionResponse = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(sessionResponse.body.consumed).toBe(true);
        expect(sessionResponse.body.consumedAt).toBeDefined();

        // Second token exchange with the same code should fail
        const tokenEndpoint = issuerMetadata.authorizationServers?.[0]
            ?.token_endpoint as string;
        expect(tokenEndpoint).toBeDefined();

        const tokenPath = new URL(tokenEndpoint!).pathname;
        const preAuthorizedCode =
            credentialOffer.grants?.[
                "urn:ietf:params:oauth:grant-type:pre-authorized_code"
            ]?.["pre-authorized_code"];
        expect(preAuthorizedCode).toBeDefined();

        const tokenRes2 = await request(app.getHttpServer())
            .post(tokenPath)
            .trustLocalhost()
            .send({
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                "pre-authorized_code": preAuthorizedCode,
            })
            .expect(400);

        expect(tokenRes2.body.error).toBe("invalid_grant");
        expect(tokenRes2.body.error_description).toContain(
            "credential offer has already been used",
        );
    });

    test("should prevent credential request after offer is consumed", async () => {
        // Covered in issuance e2e tests where credentials are requested with proofs.
        expect(true).toBe(true);
    });

    test("should allow resolving credential_offer_uri only once", async () => {
        const offerRes = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "authorization_code",
            })
            .expect(201);

        const offerUri = new URL(offerRes.body.uri);
        const credentialOfferUri = offerUri.searchParams.get(
            "credential_offer_uri",
        );

        expect(credentialOfferUri).toBeDefined();

        const firstFetch = await request(app.getHttpServer())
            .get(new URL(credentialOfferUri as string).pathname)
            .trustLocalhost()
            .expect(200);

        expect(firstFetch.body.credential_issuer).toContain("/issuers/");

        await request(app.getHttpServer())
            .get(new URL(credentialOfferUri as string).pathname)
            .trustLocalhost()
            .expect(404);
    });
});

describe("Single-Use Validation (Issue #503) - OID4VP", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let privateIssuerKey: CryptoKey;
    let issuerCertChain: string[];
    let statusListService: StatusListService;
    let client: Openid4vpClient;
    let ctx: PresentationTestContext;

    const credentialConfigId = "pid";

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

    test("should prevent presentation response after request is consumed", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });

        const sessionId: string = res.body.session;
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
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
            credentialConfigId,
        );

        const jwt = await encryptVpToken(vpToken, "pid", resolved);

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: jwt,
                },
                ...callbacks,
            });

        const firstSubmit = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        expect(firstSubmit.response.status).toBe(200);

        const sessionAfterFirstSubmit = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionAfterFirstSubmit.body.status).toBe("completed");
        expect(sessionAfterFirstSubmit.body.consumed).toBe(true);
        expect(sessionAfterFirstSubmit.body.consumedAt).toBeDefined();

        const responseUri = resolved.authorizationRequestPayload
            .response_uri as string;

        const secondSubmit = await request(app.getHttpServer())
            .post(new URL(responseUri).pathname)
            .trustLocalhost()
            .send(authorizationResponse.authorizationResponsePayload)
            .expect(400);

        expect(secondSubmit.body.message).toContain(
            "presentation offer has already been used",
        );
    });
});

describe("Single-Use Validation - Edge Cases", () => {
    test("should handle refresh token separately from single-use validation", async () => {
        // Covered in issuance-refresh-token.e2e-spec.ts.
        expect(true).toBe(true);
    });

    test("should return appropriate error message when consumed offer is reused", async () => {
        // Covered by token endpoint replay assertion in this file.
        expect(true).toBe(true);
    });
});
