import { createHash } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    FIXTURE_TRUSTED_AUTHORITIES,
    PresentationTestContext,
    setupPresentationTestApp,
} from "../utils.js";

/**
 * Compute the x509_hash client_id from the DER bytes of a PEM certificate.
 * Mirrors the logic in CertService.getCertHash().
 */
function computeCertHash(leafPem: string): string {
    const b64 = leafPem
        .replace(/-----BEGIN CERTIFICATE-----/, "")
        .replace(/-----END CERTIFICATE-----/, "")
        .replace(/\s+/g, "");
    const derBytes = Buffer.from(b64, "base64");
    return createHash("sha256")
        .update(derBytes)
        .digest()
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

describe("Presentation - Offer Creation", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: PresentationTestContext;

    beforeAll(async () => {
        ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("create oid4vp offer", async () => {
        const res = await request(app.getHttpServer())
            .post("/verifier/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: ResponseType.URI,
                requestId: "pid-no-hook",
            });

        expect(res.status).toBe(201);
        expect(res.body).toBeDefined();
        const session = res.body.session;

        // Check if the session exists
        await request(app.getHttpServer())
            .get(`/session/${session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200)
            .expect((res) => {
                expect(res.body.id).toBe(session);
            });
    });

    test("ask for an invalid oid4vp offer", async () => {
        await request(app.getHttpServer())
            .post("/verifier/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: ResponseType.URI,
                requestId: "invalid",
            })
            .expect(409)
            .expect((res) => {
                expect(res.body.message).toContain(
                    "Request ID invalid not found",
                );
            });
    });

    test("rejects an inline webhook with an empty URL", async () => {
        await request(app.getHttpServer())
            .post("/verifier/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: ResponseType.URI,
                requestId: "pid",
                webhook: { url: "", auth: { type: "none" } },
            })
            .expect(400);
    });

    test("rejects presentation configs with claim_sets but no claim ids", async () => {
        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "invalid-claim-sets",
                description: "Invalid claim_sets config",
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
                            claim_sets: [["birthdate"]],
                        },
                    ],
                },
            })
            .expect(400);
    });

    test("client_id in offer URI matches the accessKeyChainId certificate when multiple access keys exist", async () => {
        // A second access key chain with a distinct certificate (different from the fixture default)
        const secondKeyMaterial = {
            kty: "EC",
            crv: "P-256",
            d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
            x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
            y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
        };
        const secondKeyChainId = "second-access-key-chain";

        // Import a second access key chain
        await request(app.getHttpServer())
            .post("/key-chain/import")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: secondKeyChainId,
                key: secondKeyMaterial,
                usageType: KeyUsageType.Access,
                description: "Second access key chain for bug regression test",
            } as KeyChainImportDto)
            .expect(201);

        // Create a presentation config that explicitly references the second access key chain
        const presentationConfigId = "pid-second-access-key";
        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: presentationConfigId,
                description: "Presentation config using second access key",
                accessKeyChainId: secondKeyChainId,
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["https://example.com/pid"] },
                            trusted_authorities: FIXTURE_TRUSTED_AUTHORITIES,
                        },
                    ],
                },
            })
            .expect(201);

        // Retrieve the leaf certificate of the second key chain to compute the expected client_id
        const keyChainRes = await request(app.getHttpServer())
            .get(`/key-chain/${secondKeyChainId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const activeCertPem: string = keyChainRes.body.activeCertificate.pem;
        const expectedHash = computeCertHash(activeCertPem);
        const expectedClientId = `x509_hash:${expectedHash}`;

        // Generate a presentation offer using the config with the second access key
        const offerRes = await request(app.getHttpServer())
            .post("/verifier/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: ResponseType.URI,
                requestId: presentationConfigId,
            })
            .expect(201);

        // The client_id in the offer URI (used by the QR code) must match the
        // certificate hash of the configured second access key chain, not the first one.
        const offerUri: string = offerRes.body.uri;
        const params = new URLSearchParams(offerUri.split("?")[1] ?? offerUri);
        const clientIdFromOffer = params.get("client_id");

        expect(clientIdFromOffer).toBe(expectedClientId);

        // The signed authorization request JWT must carry the same client_id
        const sessionId: string = offerRes.body.session;
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.clientId).toBe(expectedClientId);
    });

    describe("Digital Credentials API origins", () => {
        const allowedOrigin = "https://shop.example";
        const configId = "pid-de-dc-api";

        beforeAll(async () => {
            const source = await request(app.getHttpServer())
                .get("/verifier/config/pid-de")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            await request(app.getHttpServer())
                .post("/verifier/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    id: configId,
                    description: "PID over the Digital Credentials API",
                    dcql_query: source.body.dcql_query,
                    allowedOrigins: [allowedOrigin],
                })
                .expect(201);
        });

        function offer(
            body: Record<string, unknown>,
            origin?: string,
        ): request.Test {
            const req = request(app.getHttpServer())
                .post("/verifier/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`);
            if (origin) req.set("Origin", origin);
            return req.send(body);
        }

        async function sessionOf(session: string) {
            const res = await request(app.getHttpServer())
                .get(`/session/${session}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            return res.body;
        }

        function payloadOf(jwt: string) {
            return JSON.parse(
                Buffer.from(jwt.split(".")[1], "base64url").toString(),
            );
        }

        test("signs expected_origin for a configuration without allowedOrigins", async () => {
            const res = await offer({
                response_type: ResponseType.DC_API,
                requestId: "pid-no-hook",
                expected_origin: "https://any.example/checkout",
            }).expect(201);

            const session = await sessionOf(res.body.session);
            expect(payloadOf(session.requestObject).expected_origins).toEqual([
                "https://any.example",
            ]);
        });

        test("ignores the Origin header without expected_origin", async () => {
            const res = await offer(
                {
                    response_type: ResponseType.DC_API,
                    requestId: "pid-no-hook",
                },
                "https://evil.example",
            ).expect(400);

            expect(res.body.message).toContain("needs expected_origin");
        });

        test("ignores the Origin header of an iso-18013-7 offer", async () => {
            const res = await offer(
                {
                    response_type: ResponseType.ISO_18013_7,
                    requestId: "pid-de",
                },
                "https://evil.example",
            ).expect(400);

            expect(res.body.message).toContain("needs expected_origin");
        });

        test("lifts the restriction when allowedOrigins is cleared with null", async () => {
            const patch = (allowedOrigins: string[] | null) =>
                request(app.getHttpServer())
                    .patch(`/verifier/config/${configId}`)
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({ allowedOrigins })
                    .expect(200);
            await patch(null);
            try {
                const res = await offer({
                    response_type: ResponseType.DC_API,
                    requestId: configId,
                    expected_origin: "https://other.example",
                }).expect(201);

                const session = await sessionOf(res.body.session);
                expect(
                    payloadOf(session.requestObject).expected_origins,
                ).toEqual(["https://other.example"]);
            } finally {
                await patch([allowedOrigin]);
            }
        });

        test("refuses a value without scheme", async () => {
            const res = await offer({
                response_type: ResponseType.DC_API,
                requestId: "pid-no-hook",
                expected_origin: "shop.example",
            }).expect(400);

            expect(res.body.message).toContain("not an http or https origin");
        });

        test("binds an iso-18013-7 offer to the only allowed origin", async () => {
            const res = await offer({
                response_type: ResponseType.ISO_18013_7,
                requestId: configId,
            }).expect(201);

            const session = await sessionOf(res.body.session);
            expect(session.browserOrigin).toBe(allowedOrigin);
        });

        test("refuses a dc-api offer whose expected_origin is not allowed", async () => {
            const res = await offer({
                response_type: ResponseType.DC_API,
                requestId: configId,
                expected_origin: "https://evil.example",
            }).expect(400);

            expect(res.body.message).toContain(
                "does not allow the origin https://evil.example",
            );
        });

        test("refuses an iso-18013-7 offer whose origin is not allowed", async () => {
            const res = await offer({
                response_type: ResponseType.ISO_18013_7,
                requestId: configId,
                expected_origin: "https://evil.example",
            }).expect(400);

            expect(res.body.message).toContain(
                "does not allow the origin https://evil.example",
            );
        });

        test("uses the only allowed origin, not the Origin header", async () => {
            const res = await offer(
                { response_type: ResponseType.DC_API, requestId: configId },
                "https://evil.example",
            ).expect(201);

            const session = await sessionOf(res.body.session);
            expect(payloadOf(session.requestObject).expected_origins).toEqual([
                allowedOrigin,
            ]);
        });

        test("signs a requested origin from several allowed ones", async () => {
            const second = "https://checkout.shop.example";
            await request(app.getHttpServer())
                .patch(`/verifier/config/${configId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ allowedOrigins: [allowedOrigin, second] })
                .expect(200);
            try {
                const res = await offer({
                    response_type: ResponseType.DC_API,
                    requestId: configId,
                    expected_origin: second,
                }).expect(201);

                const session = await sessionOf(res.body.session);
                expect(
                    payloadOf(session.requestObject).expected_origins,
                ).toEqual([second]);
            } finally {
                await request(app.getHttpServer())
                    .patch(`/verifier/config/${configId}`)
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({ allowedOrigins: [allowedOrigin] })
                    .expect(200);
            }
        });

        test("uses the only allowed origin for a server-side call", async () => {
            const res = await offer({
                response_type: ResponseType.DC_API,
                requestId: configId,
            }).expect(201);

            const session = await sessionOf(res.body.session);
            expect(payloadOf(session.requestObject).expected_origins).toEqual([
                allowedOrigin,
            ]);
        });

        test("serves the request object signed at offer time to a fetch with another Origin", async () => {
            const res = await offer({
                response_type: ResponseType.DC_API,
                requestId: configId,
            }).expect(201);
            const session = await sessionOf(res.body.session);

            const fetched = await request(app.getHttpServer())
                .get(`/presentations/${session.walletNonce}/oid4vp/request`)
                .trustLocalhost()
                .set("Origin", "https://evil.example")
                .buffer(true)
                .parse((response, callback) => {
                    let text = "";
                    response.on("data", (chunk) => (text += chunk));
                    response.on("end", () => callback(null, text));
                })
                .expect(200);

            expect(payloadOf(fetched.body).expected_origins).toEqual([
                allowedOrigin,
            ]);
        });
    });

    describe("ISO 18013-7 response endpoint", () => {
        async function isoOffer() {
            const res = await request(app.getHttpServer())
                .post("/verifier/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: ResponseType.ISO_18013_7,
                    requestId: "pid-de",
                    expected_origin: "https://shop.example",
                })
                .expect(201);
            const responseUri = new URL(res.body.org_iso_mdoc.response_uri);
            return {
                session: res.body.session as string,
                responseUri,
                walletNonce: responseUri.pathname.split("/")[2],
            };
        }

        async function statusOf(session: string) {
            const res = await request(app.getHttpServer())
                .get(`/session/${session}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
            return res.body.status;
        }

        test("names the session with a wallet nonce in the response_uri", async () => {
            const { session, responseUri, walletNonce } = await isoOffer();

            expect(responseUri.href).toBe(
                `${ctx.host}/presentations/${walletNonce}/iso-18013-7`,
            );
            expect(walletNonce).not.toBe(session);
            // The posted response reaches the session through the nonce.
            const answer = await request(app.getHttpServer())
                .post(responseUri.pathname)
                .trustLocalhost()
                .send({ data: "AAAA" })
                .expect(400);
            expect(answer.body.message).toMatch(/Invalid EncryptedResponse/);
        });

        test("does not accept the session ID the management API lists", async () => {
            const { session } = await isoOffer();

            await request(app.getHttpServer())
                .post(`/presentations/${session}/iso-18013-7`)
                .trustLocalhost()
                .send({ data: "AAAA" })
                .expect(404);
            expect(await statusOf(session)).toBe("active");
        });

        test("is the only endpoint that answers an ISO 18013-7 wallet nonce", async () => {
            const { session, walletNonce } = await isoOffer();

            // A wallet error response fails every session it finds and is
            // answered with 200. (The test app has no exception filter, so
            // the SessionNotFound is a 500 here and a 404 in production.)
            const res = await request(app.getHttpServer())
                .post(`/presentations/${walletNonce}/oid4vp`)
                .trustLocalhost()
                .type("form")
                .send({ error: "access_denied" });
            expect(res.status).not.toBe(200);
            expect(await statusOf(session)).toBe("active");
        });
    });
});
