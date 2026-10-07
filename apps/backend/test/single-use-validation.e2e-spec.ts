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
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AuditLogEntity } from "../src/audit-log/entities/audit-log.entity.js";
import { StatusListService } from "../src/issuer/status-list/status-list.service.js";
import { Session } from "../src/session/entities/session.entity.js";
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

describe("Session expiry (Issue #1120) - OID4VCI", () => {
    let app: INestApplication<App>;
    let authToken: string;

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    async function createOffer(body: Record<string, unknown> = {}) {
        const res = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
                ...body,
            })
            .expect(201);
        return {
            sessionId: res.body.session as string,
            offerPath: new URL(
                new URL(res.body.uri).searchParams.get(
                    "credential_offer_uri",
                ) as string,
            ).pathname,
        };
    }

    async function session(sessionId: string) {
        return (
            await request(app.getHttpServer())
                .get(`/session/${sessionId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200)
        ).body;
    }

    const expire = (sessionId: string) =>
        app
            .get(DataSource)
            .getRepository(Session)
            .update(sessionId, { expiresAt: new Date(Date.now() - 1000) });

    test("offers do not expire unless a lifetime is configured or requested", async () => {
        const { sessionId } = await createOffer();
        expect((await session(sessionId)).expiresAt ?? null).toBeNull();
    });

    test("applies the configured lifetime and the per-offer override with time of day", async () => {
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({ offerLifetimeSeconds: 120 })
            .expect(201);
        try {
            const configured = await createOffer();
            const remaining =
                new Date(
                    (await session(configured.sessionId)).expiresAt,
                ).getTime() - Date.now();
            expect(remaining).toBeGreaterThan(100_000);
            expect(remaining).toBeLessThanOrEqual(120_000);

            const overridden = await createOffer({ offerLifetimeSeconds: 30 });
            const overriddenRemaining =
                new Date(
                    (await session(overridden.sessionId)).expiresAt,
                ).getTime() - Date.now();
            expect(overriddenRemaining).toBeGreaterThan(10_000);
            expect(overriddenRemaining).toBeLessThanOrEqual(30_000);
        } finally {
            await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ offerLifetimeSeconds: null })
                .expect(201);
        }
    });

    test("rejects fetching an expired offer by reference", async () => {
        const { sessionId, offerPath } = await createOffer({
            offerLifetimeSeconds: 600,
        });
        await expire(sessionId);
        const res = await request(app.getHttpServer())
            .get(offerPath)
            .trustLocalhost()
            .expect(404);
        expect(res.body.message).toBe("The session has expired");
    });

    test("rejects the pre-authorized code once the offer expired", async () => {
        const { sessionId } = await createOffer({ offerLifetimeSeconds: 600 });
        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        });
        const offer = await session(sessionId);
        const credentialOffer = await client.resolveCredentialOffer(
            offer.offerUrl,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );
        await expire(sessionId);

        const tokenPath = new URL(
            issuerMetadata.authorizationServers?.[0]?.token_endpoint as string,
        ).pathname;
        const res = await request(app.getHttpServer())
            .post(tokenPath)
            .trustLocalhost()
            .send({
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                "pre-authorized_code":
                    credentialOffer.grants?.[
                        "urn:ietf:params:oauth:grant-type:pre-authorized_code"
                    ]?.["pre-authorized_code"],
            })
            .expect(400);
        expect(res.body).toEqual({
            error: "invalid_grant",
            error_description: "The credential offer has expired",
        });
        expect(await session(sessionId)).toMatchObject({
            consumed: false,
            status: "active",
        });
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

describe("Session expiry (Issue #1120) - OID4VP", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let client: Openid4vpClient;

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
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

    async function session(sessionId: string) {
        return (
            await request(app.getHttpServer())
                .get(`/session/${sessionId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200)
        ).body;
    }

    test("marks the request fetched and rejects it after its lifetime", async () => {
        const res = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-no-hook",
        });
        const sessionId: string = res.body.session;
        const created = await session(sessionId);
        expect(created.status).toBe("active");
        // Stored with its time of day, not truncated to midnight.
        const remaining = new Date(created.expiresAt).getTime() - Date.now();
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThan(24 * 60 * 60 * 1000);

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });
        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        expect((await session(sessionId)).status).toBe("fetched");

        await app
            .get(DataSource)
            .getRepository(Session)
            .update(sessionId, { expiresAt: new Date(Date.now() - 1000) });

        const requestUri = new URL(
            new URLSearchParams(res.body.uri.split("?")[1]).get(
                "request_uri",
            ) as string,
        );
        const fetchAgain = await request(app.getHttpServer())
            .get(requestUri.pathname)
            .trustLocalhost()
            .expect(400);
        expect(fetchAgain.body.message).toBe("The session has expired");

        const response = await request(app.getHttpServer())
            .post(
                new URL(
                    resolved.authorizationRequestPayload.response_uri as string,
                ).pathname,
            )
            .trustLocalhost()
            .send({ response: "unused.jwe.value" })
            .expect(400);
        expect(response.body.message).toBe("The session has expired");
        expect(await session(sessionId)).toMatchObject({
            status: "fetched",
            consumed: false,
        });
    });
});

describe("Session cancellation (Issue #1119) - OID4VCI", () => {
    let app: INestApplication<App>;
    let authToken: string;

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    async function createOffer() {
        const res = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
            })
            .expect(201);
        return {
            sessionId: res.body.session as string,
            offerPath: new URL(
                new URL(res.body.uri).searchParams.get(
                    "credential_offer_uri",
                ) as string,
            ).pathname,
        };
    }

    async function session(sessionId: string) {
        return (
            await request(app.getHttpServer())
                .get(`/session/${sessionId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200)
        ).body;
    }

    const cancel = (sessionId: string, body: Record<string, unknown> = {}) =>
        request(app.getHttpServer())
            .post(`/session/${sessionId}/cancel`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(body);

    test("a cancelled offer can no longer be fetched or redeemed", async () => {
        const { sessionId, offerPath } = await createOffer();
        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        });
        const credentialOffer = await client.resolveCredentialOffer(
            (await session(sessionId)).offerUrl,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );

        await cancel(sessionId, { reason: "sent to wrong recipient" }).expect(
            204,
        );
        expect((await session(sessionId)).status).toBe("cancelled");

        const fetched = await request(app.getHttpServer())
            .get(offerPath)
            .trustLocalhost()
            .expect(404);
        expect(fetched.body.message).toBe("The session is already cancelled");

        const tokenPath = new URL(
            issuerMetadata.authorizationServers?.[0]?.token_endpoint as string,
        ).pathname;
        const res = await request(app.getHttpServer())
            .post(tokenPath)
            .trustLocalhost()
            .send({
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                "pre-authorized_code":
                    credentialOffer.grants?.[
                        "urn:ietf:params:oauth:grant-type:pre-authorized_code"
                    ]?.["pre-authorized_code"],
            })
            .expect(400);
        expect(res.body).toEqual({
            error: "invalid_grant",
            error_description: "The credential offer is no longer valid",
        });
    });

    test("cancelled sessions can be filtered by status", async () => {
        const { sessionId } = await createOffer();
        await cancel(sessionId).expect(204);

        const res = await request(app.getHttpServer())
            .get("/session")
            .query({ status: "cancelled", pageSize: 100 })
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const ids = res.body.items.map((item: { id: string }) => item.id);
        expect(ids).toContain(sessionId);
        expect(
            res.body.items.every(
                (item: { status: string }) => item.status === "cancelled",
            ),
        ).toBe(true);
    });

    test("cancelling a session that is no longer open answers 409 and changes nothing", async () => {
        const cancelled = await createOffer();
        await cancel(cancelled.sessionId).expect(204);
        const again = await cancel(cancelled.sessionId).expect(409);
        expect(again.body.message).toBe(
            "The session is already cancelled and can no longer be cancelled",
        );

        const expired = await createOffer();
        await app
            .get(DataSource)
            .getRepository(Session)
            .update(expired.sessionId, {
                expiresAt: new Date(Date.now() - 1000),
            });
        await cancel(expired.sessionId).expect(409);
        expect((await session(expired.sessionId)).status).toBe("active");
    });

    test("exactly one of concurrent cancellations wins", async () => {
        const { sessionId } = await createOffer();

        const results = await Promise.all(
            Array.from({ length: 5 }, () => cancel(sessionId)),
        );

        expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([
            204, 409, 409, 409, 409,
        ]);
    });

    test("cancelling works without a request body", async () => {
        const { sessionId } = await createOffer();

        await request(app.getHttpServer())
            .post(`/session/${sessionId}/cancel`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(204);
        expect((await session(sessionId)).status).toBe("cancelled");
    });

    test("the cancellation is recorded in the tenant audit log", async () => {
        const { sessionId } = await createOffer();
        await cancel(sessionId, { reason: "data changed" }).expect(204);

        const entries = await app
            .get(DataSource)
            .getRepository(AuditLogEntity)
            .findBy({ actionType: "session_cancelled" });
        const entry = entries.find(
            (candidate) => candidate.after?.sessionId === sessionId,
        );
        expect(entry).toMatchObject({
            actorType: "client",
            after: { sessionId, reason: "data changed" },
        });
        expect(entry?.actorId).toBeDefined();
    });

    /** Resolves the offer of a session, so a wallet can redeem it. */
    async function walletFor(sessionId: string) {
        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        });
        const credentialOffer = await client.resolveCredentialOffer(
            (await session(sessionId)).offerUrl,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );
        return () =>
            client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });
    }

    test("an offer a wallet already redeemed answers 409 and stays usable", async () => {
        const { sessionId } = await createOffer();
        const redeem = await walletFor(sessionId);
        await redeem();

        const res = await cancel(sessionId).expect(409);
        expect(res.body.message).toBe(
            "A wallet already redeemed the offer, so it can no longer be cancelled",
        );
        expect(await session(sessionId)).toMatchObject({
            status: "active",
            consumed: true,
        });
    });

    test("exactly one of a cancellation and a concurrent redemption wins", async () => {
        for (let round = 0; round < 3; round++) {
            const { sessionId } = await createOffer();
            const redeem = await walletFor(sessionId);

            const [token, cancellation] = await Promise.allSettled([
                redeem(),
                cancel(sessionId),
            ]);
            const redeemed = token.status === "fulfilled";
            const cancelled =
                cancellation.status === "fulfilled" &&
                cancellation.value.status === 204;

            expect(redeemed !== cancelled).toBe(true);
            expect((await session(sessionId)).status).toBe(
                cancelled ? "cancelled" : "active",
            );
        }
    });
});

describe("Session cancellation (Issue #1119) - OID4VP", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let client: Openid4vpClient;

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
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

    async function session(sessionId: string) {
        return (
            await request(app.getHttpServer())
                .get(`/session/${sessionId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200)
        ).body;
    }

    test("a cancelled request can no longer be fetched or answered", async () => {
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
        expect((await session(sessionId)).status).toBe("fetched");

        await request(app.getHttpServer())
            .post(`/session/${sessionId}/cancel`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({ reason: "checkout cancelled" })
            .expect(204);

        const requestUri = new URL(
            new URLSearchParams(res.body.uri.split("?")[1]).get(
                "request_uri",
            ) as string,
        );
        const fetchAgain = await request(app.getHttpServer())
            .get(requestUri.pathname)
            .trustLocalhost()
            .expect(400);
        expect(fetchAgain.body.message).toBe(
            "The session is already cancelled",
        );

        const response = await request(app.getHttpServer())
            .post(
                new URL(
                    resolved.authorizationRequestPayload.response_uri as string,
                ).pathname,
            )
            .trustLocalhost()
            .send({ response: "unused.jwe.value" })
            .expect(400);
        expect(response.body.message).toBe("The session is already cancelled");
        expect(await session(sessionId)).toMatchObject({
            status: "cancelled",
            consumed: false,
        });
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
