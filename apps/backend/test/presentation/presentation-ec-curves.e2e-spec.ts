import "reflect-metadata";
import { createHash } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { decodeProtectedHeader, importJWK } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { KeyChainService } from "../../src/crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";
import {
    createKeyChain,
    deleteKeyChain,
    expectJwsSignedWithX5c,
    pemChainToX5c,
} from "../utils-ec.js";

/** Fixture key chains reused by the ES384 / ES512 trust lists. */
const TRUST_LIST_KEY_CHAIN_ID = "570852d7-7e7f-40af-a0e3-a6ebffd75ed0";
const STATUS_LIST_KEY_CHAIN_ID = "1f8c6b29-a4d3-4e7f-b2a0-9c5d13e8f746";

/**
 * OID4VP with ES384 / ES512 key chains: the request object follows the
 * curve of the access key chain, and the verifier accepts an SD-JWT VC
 * issued and bound (KB-JWT) with the same algorithm.
 */
describe("Presentation - ES384 / ES512 key chains (e2e)", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let statusListService: StatusListService;
    let client: Openid4vpClient;

    const api = () => request(app.getHttpServer());

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        statusListService = ctx.statusListService;
        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => ctx.host),
            },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    /**
     * Creates a presentation configuration for the PID that pins the access
     * key chain and trusts the given trust list. Returns a function that
     * deletes it again.
     */
    async function createPresentationConfig(
        id: string,
        accessKeyChainId: string,
        trustListId = "580831bc-ef11-43f4-a3be-a2b6bf1b29a3",
    ): Promise<() => Promise<void>> {
        await api()
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id,
                description: `PID, request object signed by ${accessKeyChainId}`,
                accessKeyChainId,
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
                            trusted_authorities: [
                                {
                                    type: "etsi_tl",
                                    values: [{ trustListId }],
                                },
                            ],
                        },
                    ],
                },
            })
            .expect(201);
        return async () => {
            await api()
                .delete(`/verifier/config/${id}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`);
        };
    }

    /** The leaf of a key chain's active certificate as base64 DER. */
    async function leafOf(keyChainId: string): Promise<string> {
        const keyChain = await app
            .get(KeyChainService)
            .getEntity("root", keyChainId);
        return pemChainToX5c(keyChain.activeCertificate)[0];
    }

    /** Starts a presentation and resolves its request as a wallet would. */
    async function startPresentation(requestId: string) {
        const offer = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId,
        }).expect(201);
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: offer.body.uri,
        });
        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        return { offer, authRequest, resolved };
    }

    test.each(["ES384", "ES512"] as const)(
        "signs the request object with the algorithm of an %s access key chain",
        async (alg) => {
            const accessKeyChainId = await createKeyChain(app, authToken, {
                usageType: KeyUsageType.Access,
                alg,
            });
            const configId = `pid-request-${alg}`;
            let deleteConfig: (() => Promise<void>) | undefined;
            try {
                deleteConfig = await createPresentationConfig(
                    configId,
                    accessKeyChainId,
                );
                const offer = await createPresentationRequest(app, authToken, {
                    response_type: ResponseType.URI,
                    requestId: configId,
                }).expect(201);

                const requestUri = new URL(
                    new URL(offer.body.uri).searchParams.get("request_uri")!,
                );
                const fetched = await api()
                    .get(requestUri.pathname)
                    .trustLocalhost()
                    .expect(200);

                const payload = await expectJwsSignedWithX5c(fetched.text, alg);
                // Signed by the pinned key chain, whose leaf the client_id names.
                const leaf = await leafOf(accessKeyChainId);
                expect(decodeProtectedHeader(fetched.text).x5c?.[0]).toBe(leaf);
                expect(payload.client_id).toBe(
                    `x509_hash:${createHash("sha256")
                        .update(Buffer.from(leaf, "base64"))
                        .digest("base64url")}`,
                );
            } finally {
                await deleteConfig?.();
                await deleteKeyChain(app, authToken, accessKeyChainId);
            }
        },
    );

    describe.each(["ES384", "ES512"] as const)(
        "SD-JWT VC issued and bound with %s",
        (alg) => {
            const configId = `pid-${alg}`;
            const trustListId = `${alg}-pid-trust-list`;
            let issuerKey: CryptoKey;
            let issuerX5c: string[];

            beforeAll(async () => {
                const accessKeyChainId = await createKeyChain(app, authToken, {
                    usageType: KeyUsageType.Access,
                    alg,
                });
                const issuerKeyChainId = await createKeyChain(app, authToken, {
                    usageType: KeyUsageType.Attestation,
                    alg,
                    type: KeyChainType.InternalChain,
                });

                const trustList: TrustListCreateDto = {
                    id: trustListId,
                    description: `${alg} PID issuer`,
                    keyChainId: TRUST_LIST_KEY_CHAIN_ID,
                    entities: [
                        {
                            type: "internal",
                            issuerKeyChainId,
                            revocationKeyChainId: STATUS_LIST_KEY_CHAIN_ID,
                            info: {
                                name: `${alg} PID Provider`,
                                contactUri: "info@example.com",
                                website: "https://example.com/",
                                lang: "en",
                            },
                        },
                    ],
                };
                await api()
                    .post("/trust-list")
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send(trustList)
                    .expect(201);
                await createPresentationConfig(
                    configId,
                    accessKeyChainId,
                    trustListId,
                );

                const issuer = await app
                    .get(KeyChainService)
                    .getEntity("root", issuerKeyChainId);
                issuerKey = (await importJWK(
                    issuer.activeJwk,
                    alg,
                )) as CryptoKey;
                issuerX5c = pemChainToX5c(issuer.activeCertificate);
            });

            /**
             * An SD-JWT VC signed with the issuer key and presented with a
             * KB-JWT of the same algorithm for the request's audience and nonce.
             */
            function presentCredential(kb: { aud: string; nonce: string }) {
                return preparePresentation(
                    { iat: Math.floor(Date.now() / 1000), ...kb },
                    issuerKey,
                    issuerX5c,
                    statusListService,
                    "pid",
                    `ec-${alg}`,
                    alg,
                );
            }

            /** Submits the vp_token and returns the HTTP status and the session. */
            async function submit(
                started: Awaited<ReturnType<typeof startPresentation>>,
                vpToken: string,
            ) {
                const { offer, authRequest, resolved } = started;
                const response = await encryptVpToken(vpToken, "pid", resolved);
                const authorizationResponse =
                    await client.createOpenid4vpAuthorizationResponse({
                        authorizationRequestPayload: authRequest.params,
                        authorizationResponsePayload: { response },
                        ...callbacks,
                    });
                const submitted =
                    await client.submitOpenid4vpAuthorizationResponse({
                        authorizationResponsePayload:
                            authorizationResponse.authorizationResponsePayload,
                        authorizationRequestPayload:
                            resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
                    });
                const session = await api()
                    .get(`/session/${offer.body.session}`)
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .expect(200);
                return {
                    status: submitted.response.status,
                    session: session.body,
                };
            }

            test("verifies the presentation", async () => {
                const started = await startPresentation(configId);
                const { client_id, nonce } =
                    started.resolved.authorizationRequestPayload;
                const vpToken = await presentCredential({
                    aud: client_id as string,
                    nonce,
                });

                const { status, session } = await submit(started, vpToken);

                expect(status).toBe(200);
                expect(session.status).toBe("completed");
                expect(session.outcome.credentials).toEqual([
                    expect.objectContaining({ id: "pid", verified: true }),
                ]);
            });

            test("refuses a presentation whose KB-JWT signature was tampered with", async () => {
                const started = await startPresentation(configId);
                const { client_id, nonce } =
                    started.resolved.authorizationRequestPayload;
                const vpToken = await presentCredential({
                    aud: client_id as string,
                    nonce,
                });
                // The KB-JWT is the last segment; flip one character in the
                // middle of its signature.
                const kbJwt = vpToken.slice(vpToken.lastIndexOf("~") + 1);
                const signatureStart = kbJwt.lastIndexOf(".") + 1;
                const position = signatureStart + 40;
                const tampered =
                    vpToken.slice(0, vpToken.length - kbJwt.length) +
                    kbJwt.slice(0, position) +
                    (kbJwt[position] === "A" ? "B" : "A") +
                    kbJwt.slice(position + 1);

                const { status, session } = await submit(started, tampered);

                expect(status).toBe(400);
                expect(session.status).toBe("failed");
                expect(session.errorReason).toContain("Invalid JWT Signature");
            });
        },
    );
});
