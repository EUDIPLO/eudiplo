import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import * as x509Lib from "@peculiar/x509";
import { CryptoKey, generateKeyPair } from "jose";
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
import {
    PresentationRequest,
    ResponseType,
} from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    PresentationTestContext,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Presentation - OpenID Federation", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let statusListService: PresentationTestContext["statusListService"];
    let ctx: PresentationTestContext;

    let client: Openid4vpClient;

    beforeAll(async () => {
        ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        statusListService = ctx.statusListService;

        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });

        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "pid-fed-only",
                description: "PID with OpenID Federation trusted authority",
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
                            claims: [{ path: ["address", "locality"] }],
                            trusted_authorities: [
                                {
                                    type: "openid_federation",
                                    values: ["https://ta-fed.example.org"],
                                },
                            ],
                        },
                    ],
                },
            })
            .expect(201);
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

    test("verifier processes SD-JWT when OpenID Federation trusted authority is configured", async () => {
        const federationEntityId = "https://wallet-fed.example.org";
        const trustAnchor = "https://ta-fed.example.org";

        x509Lib.cryptoProvider.set(globalThis.crypto);
        const fedKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });

        const fedCert = await x509Lib.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "01",
                name: `C=DE, CN=${federationEntityId}`,
                notBefore: new Date(),
                notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys: {
                    privateKey: fedKeyPair.privateKey,
                    publicKey: fedKeyPair.publicKey,
                },
            },
        );

        const fedX5c = [fedCert.toString("base64")];

        const _fedScope = nock(/wallet-fed\.example\.org/)
            .get(/\/\.well-known\/openid-federation\/?$/)
            .reply(200, {
                sub: federationEntityId,
                authority_hints: [trustAnchor],
            });

        const presentationReq: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-fed-only",
        };

        const createRes = await createPresentationRequest(
            app,
            authToken,
            presentationReq,
        );

        const sessionId = createRes.body.session;

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: createRes.body.uri,
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
            fedKeyPair.privateKey as CryptoKey,
            fedX5c,
            statusListService,
            "pid",
        );

        const encryptedVp = await encryptVpToken(vpToken, "pid", resolved);

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: encryptedVp,
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

        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(["completed", "failed"]).toContain(sessionRes.body.status);
    });
});
