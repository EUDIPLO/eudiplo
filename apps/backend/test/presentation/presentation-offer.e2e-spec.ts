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
});
