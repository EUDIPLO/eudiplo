import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    Jwk,
    JwtSignerJwk,
} from "@openid4vc/oauth2";
import {
    type IssuerMetadataResult,
    Openid4vciClient,
} from "@openid4vc/openid4vci";
import { digest } from "@owf/crypto";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import {
    type CompactJWEHeaderParameters,
    compactDecrypt,
    exportJWK,
    generateKeyPair,
} from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import { EncryptionService } from "../../src/crypto/encryption/encryption.service.js";
import {
    callbacks,
    getSignJwtCallback,
    setupIssuanceTestApp,
} from "../utils.js";
import {
    encryptRequest as encrypt,
    responseEncryption,
    withoutEpkCurve,
} from "./request-encryption-helpers.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

/**
 * Encryption rules of the deferred credential endpoint (OpenID4VCI 1.0
 * Sections 9.1 and 10): the same as at the credential endpoint. An encrypted
 * request names the advertised key, response encryption is requested only in
 * an encrypted request, and `credentialRequestEncryption` enforces encrypted
 * requests.
 */
describe("Issuance - deferred credential request encryption", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let clientId: string;

    const sdjwt = new SDJwtVcInstance({
        hasher: digest,
        hashAlg: "sha-256",
    });

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        clientId = ctx.clientId;
    });

    afterEach(() => {
        nock.cleanAll();
    });

    afterAll(async () => {
        await app?.close();
    });

    /** A deferred transaction of `citizen` and the access token of its session. */
    async function prepareDeferredTransaction() {
        nock("http://localhost:8787")
            .post("/deferred", () => true)
            .reply(200, { deferred: true, interval: 1 });

        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                flow: "pre_authorized_code",
                response_type: "uri",
                credentialConfigurationIds: ["citizen"],
                credentialClaims: {
                    citizen: {
                        type: "webhook",
                        webhook: {
                            url: "http://localhost:8787/deferred",
                            auth: { type: "none" },
                        },
                    },
                },
            })
            .expect(201);

        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });
        const credentialOffer = await client.resolveCredentialOffer(
            offerResponse.body.uri,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );
        const { accessTokenResponse } =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });
        const { c_nonce } = await client.requestNonce({ issuerMetadata });
        const { jwt } = await client.createCredentialRequestJwtProof({
            issuerMetadata,
            signer: {
                method: "jwk",
                alg: "ES256",
                publicJwk: holderPublicKeyJwk,
            } as JwtSignerJwk,
            clientId,
            issuedAt: new Date(),
            credentialConfigurationId: "citizen",
            nonce: c_nonce,
        });

        const accessToken = accessTokenResponse.access_token;
        const credentialResponse = await request(app.getHttpServer())
            .post(
                new URL(issuerMetadata.credentialIssuer.credential_endpoint)
                    .pathname,
            )
            .trustLocalhost()
            .set("Authorization", `Bearer ${accessToken}`)
            .send({
                credential_configuration_id: "citizen",
                proofs: { jwt: [jwt] },
            })
            .expect(202);
        const transactionId = credentialResponse.body.transaction_id as string;
        expect(transactionId).toEqual(expect.any(String));

        return { issuerMetadata, accessToken, transactionId };
    }

    async function complete(transactionId: string, town: string) {
        await request(app.getHttpServer())
            .post(`/issuer/deferred/${transactionId}/complete`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({ claims: { town } })
            .expect(200);
    }

    function postDeferred(
        issuerMetadata: IssuerMetadataResult,
        accessToken: string,
        contentType: string,
        body: string | Record<string, unknown>,
    ) {
        const endpoint =
            issuerMetadata.credentialIssuer.deferred_credential_endpoint;
        if (!endpoint) throw new Error("no deferred_credential_endpoint");
        return request(app.getHttpServer())
            .post(new URL(endpoint).pathname)
            .trustLocalhost()
            .set("Authorization", `Bearer ${accessToken}`)
            .set("Content-Type", contentType)
            .send(body);
    }

    async function setIssuanceConfig(changes: Record<string, unknown>) {
        const current = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({ ...current.body, ...changes })
            .expect(201);
        return current.body as Record<string, unknown>;
    }

    test("answers an encrypted request of a pending transaction with issuance_pending", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, { transaction_id: transactionId }),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ error: "issuance_pending" });
    });

    test.each(["A128GCM", "A256GCM"])(
        "returns a plain credential for an encrypted request with enc %s without response encryption",
        async (enc) => {
            const { issuerMetadata, accessToken, transactionId } =
                await prepareDeferredTransaction();
            await complete(transactionId, "Hamburg");

            const response = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(
                    issuerMetadata,
                    { transaction_id: transactionId },
                    { enc },
                ),
            );

            expect(response.status).toBe(200);
            expect(response.headers["content-type"]).toMatch(
                /^application\/json/,
            );
            const claims = await sdjwt.getClaims(
                response.body.credentials[0].credential,
            );
            expect(claims.town).toBe("Hamburg");
        },
    );

    test("returns an encrypted credential for an encrypted request that asks for one", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");
        const { privateKey, parameters } = await responseEncryption("wallet");

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, {
                transaction_id: transactionId,
                credential_response_encryption: parameters,
            }),
        );

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toMatch(/^application\/jwt/);
        const { plaintext, protectedHeader } = await compactDecrypt(
            response.text,
            privateKey,
        );
        expect(protectedHeader).toMatchObject({
            alg: "ECDH-ES",
            enc: "A128GCM",
            kid: "wallet",
        });
        const body = JSON.parse(new TextDecoder().decode(plaintext));
        const claims = await sdjwt.getClaims(body.credentials[0].credential);
        expect(claims.town).toBe("Berlin");
    });

    // The zip and crit rows also pin the descriptions the credential
    // endpoint uses, so its own copy of these rules cannot drift apart.
    test.each<[string, Partial<CompactJWEHeaderParameters>, string?]>([
        ["without kid", { kid: undefined }],
        ["with an unknown kid", { kid: "unknown" }],
        ["with another alg", { alg: "ECDH-ES+A128KW" }],
        ["with another enc", { enc: "A128CBC-HS256" }],
        [
            "with zip",
            { zip: "DEF" },
            "Compressed credential requests are not supported",
        ],
        [
            "with crit",
            { crit: ["x-ext"], "x-ext": true },
            "Credential request JWE must not contain a critical ('crit') header parameter",
        ],
    ])(
        "rejects an encrypted request %s",
        async (_case, header, description) => {
            const { issuerMetadata, accessToken, transactionId } =
                await prepareDeferredTransaction();
            await complete(transactionId, "Berlin");

            const response = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(
                    issuerMetadata,
                    { transaction_id: transactionId },
                    header,
                ),
            );

            expect(response.status).toBe(400);
            expect(response.body).toMatchObject({
                error: "invalid_encryption_parameters",
                ...(description && { error_description: description }),
            });

            // A refused request does not use up the credential.
            const retry = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/json",
                { transaction_id: transactionId },
            );
            expect(retry.status).toBe(200);
        },
    );

    test("rejects a plain request that asks for an encrypted response", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");
        const { parameters } = await responseEncryption();

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/json",
            {
                transaction_id: transactionId,
                credential_response_encryption: parameters,
            },
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
    });

    test("rejects an unsupported response encryption enc", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        const { parameters } = await responseEncryption();

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, {
                transaction_id: transactionId,
                credential_response_encryption: {
                    ...parameters,
                    enc: "unsupported",
                },
            }),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
    });

    test("rejects a request without transaction_id with invalid_credential_request", async () => {
        const { issuerMetadata, accessToken } =
            await prepareDeferredTransaction();

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/json",
            {},
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_credential_request",
        });
    });

    test("rejects a JWE that names the advertised key but does not decrypt with it", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");
        const { publicKey } = await generateKeyPair("ECDH-ES", {
            extractable: true,
        });

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(
                issuerMetadata,
                { transaction_id: transactionId },
                {},
                await exportJWK(publicKey),
            ),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
        const retry = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/json",
            { transaction_id: transactionId },
        );
        expect(retry.status).toBe(200);
    });

    test("answers a decryption failure on the issuer's side with HTTP 500", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        const decrypt = vi
            .spyOn(app.get(EncryptionService), "decryptJweToJson")
            .mockRejectedValueOnce(new Error("KMS unavailable"));

        try {
            const response = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(issuerMetadata, {
                    transaction_id: transactionId,
                }),
            );

            expect(decrypt).toHaveBeenCalledOnce();
            expect(response.status).toBe(500);
            expect(JSON.stringify(response.body)).not.toContain(
                "KMS unavailable",
            );
        } finally {
            decrypt.mockRestore();
        }
    });

    test("rejects a JWE whose epk cannot be imported with invalid_encryption_parameters", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            withoutEpkCurve(
                await encrypt(issuerMetadata, {
                    transaction_id: transactionId,
                }),
            ),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
    });

    test("rejects a response encryption key that cannot be used and keeps the credential", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");
        const { parameters } = await responseEncryption();
        const { x: _x, y: _y, ...jwkWithoutPoint } = parameters.jwk;

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, {
                transaction_id: transactionId,
                credential_response_encryption: {
                    ...parameters,
                    jwk: jwkWithoutPoint,
                },
            }),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
        const retry = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, {
                transaction_id: transactionId,
                credential_response_encryption: parameters,
            }),
        );
        expect(retry.status).toBe(200);
    });

    test("accepts an encrypted poll sent as application/openid4vci-credential-request+jwt", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/openid4vci-credential-request+jwt",
            await encrypt(issuerMetadata, { transaction_id: transactionId }),
        );

        expect(response.status).toBe(200);
        expect(response.body.credentials[0].credential).toEqual(
            expect.any(String),
        );
    });

    test("rejects an application/jwt body that is not a compact JWE", async () => {
        const { issuerMetadata, accessToken } =
            await prepareDeferredTransaction();

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/jwt",
            "not-a-jwe",
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
    });

    test("ignores unknown members of a plain request", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");

        const response = await postDeferred(
            issuerMetadata,
            accessToken,
            "application/json",
            { transaction_id: transactionId, unknown: 1 },
        );

        expect(response.status).toBe(200);
        expect(response.body.credentials).toHaveLength(1);
    });

    test("requires response encryption when credentialResponseEncryption is set", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");
        const previous = await setIssuanceConfig({
            credentialResponseEncryption: true,
        });

        try {
            const plain = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/json",
                { transaction_id: transactionId },
            );
            expect(plain.status).toBe(400);
            expect(plain.body).toMatchObject({
                error: "invalid_encryption_parameters",
            });

            const withoutResponseEncryption = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(issuerMetadata, {
                    transaction_id: transactionId,
                }),
            );
            expect(withoutResponseEncryption.status).toBe(400);
            expect(withoutResponseEncryption.body).toMatchObject({
                error: "invalid_encryption_parameters",
            });

            const { parameters } = await responseEncryption();
            const encrypted = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(issuerMetadata, {
                    transaction_id: transactionId,
                    credential_response_encryption: parameters,
                }),
            );
            expect(encrypted.status).toBe(200);
            expect(encrypted.headers["content-type"]).toMatch(
                /^application\/jwt/,
            );
        } finally {
            await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(previous)
                .expect(201);
        }
    });

    test("rejects a plain request when credentialRequestEncryption is set", async () => {
        const { issuerMetadata, accessToken, transactionId } =
            await prepareDeferredTransaction();
        await complete(transactionId, "Berlin");
        const previous = await setIssuanceConfig({
            credentialRequestEncryption: true,
        });

        try {
            const plain = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/json",
                { transaction_id: transactionId },
            );
            expect(plain.status).toBe(400);
            expect(plain.body).toMatchObject({
                error: "invalid_encryption_parameters",
            });

            const encrypted = await postDeferred(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(issuerMetadata, {
                    transaction_id: transactionId,
                }),
            );
            expect(encrypted.status).toBe(200);
            expect(encrypted.body.credentials[0].credential).toEqual(
                expect.any(String),
            );
        } finally {
            await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(previous)
                .expect(201);
        }
    });
});
