import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { StatusList } from "@owf/token-status-list";
import { base64url, importPKCS8, SignJWT } from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { PresentationConfigCreateDto } from "../../src/verifier/presentations/dto/presentation-config-create.dto.js";
import {
    createMockTrustListJwt,
    generateSelfSignedCertificate,
} from "../issuance/attestation-trust-helpers.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    preparePresentation,
    readConfig,
    setupPresentationTestApp,
} from "../utils.js";

type Signer = Awaited<ReturnType<typeof generateSelfSignedCertificate>>;

/**
 * The status list of a presented credential must be signed under the
 * revocation service of the issuer's trusted entity. An issuer listed without
 * a revocation service must sign it under the certificate it is listed with:
 * any other signer could serve a list in which a revoked credential is valid.
 * Issuers listed as EAA and as Pub-EAA providers (ETSI TS 119 602 Annex H)
 * are both trusted.
 */
describe.each([
    "http://uri.etsi.org/19602/SvcType/EAA/Issuance",
    "http://uri.etsi.org/19602/SvcType/PubEAA/Issuance",
])(
    "Presentation - status list signer of an issuer listed as %s without revocation service",
    (issuanceServiceType) => {
        let app: INestApplication<App>;
        let authToken: string;
        let host: string;
        let client: Openid4vpClient;
        let issuer: Signer;
        const requestId = `pid-no-revocation-service-${randomUUID()}`;

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

            // An external trust list naming the issuer with an issuance service
            // and no revocation service.
            issuer = await generateSelfSignedCertificate();
            const listSigner = await generateSelfSignedCertificate();
            const trustListPath = `/trust-list-${randomUUID()}`;
            nock("http://localhost:8787")
                .persist()
                .get(trustListPath)
                .reply(
                    200,
                    await createMockTrustListJwt(
                        listSigner,
                        issuer.certificate,
                        issuanceServiceType,
                    ),
                    { "Content-Type": "application/jwt" },
                );

            const config = readConfig<PresentationConfigCreateDto>(
                join(
                    resolve(__dirname, "../fixtures"),
                    "haip/presentation/pid.json",
                ),
            );
            config.id = requestId;
            config.dcql_query.credentials[0].trusted_authorities = [
                {
                    type: "etsi_tl",
                    values: [
                        {
                            url: `http://localhost:8787${trustListPath}`,
                            verifierX509Der:
                                listSigner.certificate.toString("base64"),
                        },
                    ],
                },
            ] as never;
            delete (config as { webhookEndpointId?: string }).webhookEndpointId;
            await request(app.getHttpServer())
                .post("/verifier/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(config)
                .expect(201);
        });

        afterEach(() => {
            nock.abortPendingRequests();
        });

        afterAll(async () => {
            nock.cleanAll();
            await app?.close();
        });

        /** Status list JWT for `uri` in which every status is valid. */
        async function statusListJwt(signer: Signer, uri: string) {
            const key = await importPKCS8(
                "-----BEGIN PRIVATE KEY-----\n" +
                    Buffer.from(
                        await globalThis.crypto.subtle.exportKey(
                            "pkcs8",
                            signer.privateKey,
                        ),
                    ).toString("base64") +
                    "\n-----END PRIVATE KEY-----",
                "ES256",
            );
            const list = new StatusList(new Array(16).fill(0), 1);
            return new SignJWT({
                sub: uri,
                status_list: {
                    bits: 1,
                    lst: base64url.encode(list.compressStatusListToBytes()),
                },
            })
                .setProtectedHeader({
                    alg: "ES256",
                    typ: "statuslist+jwt",
                    x5c: [signer.certificate.toString("base64")],
                })
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(key);
        }

        /**
         * Present a credential of the issuer whose status names a status list
         * served signed by `statusListSigner`, and return the session.
         */
        async function presentWithStatusListSignedBy(statusListSigner: Signer) {
            const statusListPath = `/status-list-${randomUUID()}`;
            const statusListUri = `http://localhost:8787${statusListPath}`;
            nock("http://localhost:8787")
                .get(statusListPath)
                .reply(
                    200,
                    await statusListJwt(statusListSigner, statusListUri),
                    {
                        "Content-Type": "application/statuslist+jwt",
                    },
                );

            const res = await createPresentationRequest(app, authToken, {
                response_type: ResponseType.URI,
                requestId,
            });
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
                    aud: resolved.authorizationRequestPayload
                        .client_id as string,
                    nonce: resolved.authorizationRequestPayload.nonce,
                },
                issuer.privateKey,
                [issuer.certificate.toString("base64")],
                {
                    createEntry: async () => ({
                        status: { status_list: { idx: 3, uri: statusListUri } },
                    }),
                } as unknown as StatusListService,
                "pid",
            );
            const authorizationResponse =
                await client.createOpenid4vpAuthorizationResponse({
                    authorizationRequestPayload: authRequest.params,
                    authorizationResponsePayload: {
                        response: await encryptVpToken(
                            vpToken,
                            "pid",
                            resolved,
                        ),
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

            const session = await request(app.getHttpServer())
                .get(`/session/${res.body.session}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            return { status: submitRes.response.status, session: session.body };
        }

        test("accepts a status list signed with the issuer's certificate", async () => {
            const { status, session } =
                await presentWithStatusListSignedBy(issuer);

            expect(status).toBe(200);
            expect(session.status).toBe("completed");
        });

        test("rejects a status list signed by another key", async () => {
            const attacker = await generateSelfSignedCertificate();

            const { status, session } =
                await presentWithStatusListSignedBy(attacker);

            expect(status).toBe(400);
            expect(session.status).toBe("failed");
            expect(session.errorReason).toContain(
                "Status List JWT verification failed",
            );
        });
    },
);
