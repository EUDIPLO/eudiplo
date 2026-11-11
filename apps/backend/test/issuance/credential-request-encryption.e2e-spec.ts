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
import {
    type CompactJWEHeaderParameters,
    compactDecrypt,
    exportJWK,
    generateKeyPair,
} from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { EncryptionService } from "../../src/crypto/encryption/encryption.service.js";
import {
    callbacks,
    getSignJwtCallback,
    setupIssuanceTestApp,
} from "../utils.js";
import {
    advertisedKey,
    encryptRequest as encrypt,
    responseEncryption as walletResponseEncryption,
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
 * Encryption rules of the credential endpoint (OpenID4VCI 1.0 Sections 8.2
 * and 10): response encryption only in an encrypted request, the JWE header
 * names the advertised key, and `credentialRequestEncryption` enforces
 * encrypted requests.
 */
describe("Issuance - credential request encryption", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let clientId: string;

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        clientId = ctx.clientId;
    });

    afterAll(async () => {
        await app?.close();
    });

    /** Offer, access token and a fresh key proof for `pid-no-key`. */
    async function prepareCredentialRequest() {
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
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
            credentialConfigurationId: "pid-no-key",
            nonce: c_nonce,
        });

        return {
            issuerMetadata,
            accessToken: accessTokenResponse.access_token,
            body: {
                credential_configuration_id: "pid-no-key",
                proofs: { jwt: [jwt] },
            } as Record<string, unknown>,
        };
    }

    function postCredential(
        issuerMetadata: IssuerMetadataResult,
        accessToken: string,
        contentType: string,
        body: string | Record<string, unknown>,
    ) {
        return request(app.getHttpServer())
            .post(
                new URL(issuerMetadata.credentialIssuer.credential_endpoint)
                    .pathname,
            )
            .trustLocalhost()
            .set("Authorization", `Bearer ${accessToken}`)
            .set("Content-Type", contentType)
            .send(body);
    }

    test("advertises the encryption key with kid and alg ECDH-ES, without the private part", async () => {
        const { issuerMetadata } = await prepareCredentialRequest();
        const key = advertisedKey(issuerMetadata);

        expect(key).toMatchObject({ alg: "ECDH-ES", use: "enc" });
        expect(key.kid).toEqual(expect.any(String));
        expect(key).not.toHaveProperty("d");
    });

    test.each(["A128GCM", "A256GCM"])(
        "issues for an encrypted request to the advertised key with enc %s",
        async (enc) => {
            const { issuerMetadata, accessToken, body } =
                await prepareCredentialRequest();

            const response = await postCredential(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(issuerMetadata, body, { enc }),
            );

            expect(response.status).toBe(200);
            expect(response.body.credentials).toHaveLength(1);
        },
    );

    test("returns an encrypted response for an encrypted request that asks for one", async () => {
        const { issuerMetadata, accessToken, body } =
            await prepareCredentialRequest();

        const { privateKey, parameters } = await walletResponseEncryption();
        const response = await postCredential(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, {
                ...body,
                credential_response_encryption: parameters,
            }),
        );

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toMatch(/^application\/jwt/);
        // The wallet key has no kid, so the JWE names none.
        const { plaintext, protectedHeader } = await compactDecrypt(
            response.text,
            privateKey,
        );
        expect(protectedHeader.kid).toBeUndefined();
        expect(
            JSON.parse(new TextDecoder().decode(plaintext)).credentials,
        ).toHaveLength(1);
    });

    test.each<[string, Partial<CompactJWEHeaderParameters>]>([
        ["without kid", { kid: undefined }],
        ["with an unknown kid", { kid: "unknown" }],
        ["with another alg", { alg: "ECDH-ES+A128KW" }],
        ["with another enc", { enc: "A128CBC-HS256" }],
    ])("rejects an encrypted request %s", async (_case, header) => {
        const { issuerMetadata, accessToken, body } =
            await prepareCredentialRequest();

        const response = await postCredential(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, body, header),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
    });

    test("answers an encrypted request whose plaintext is not JSON with invalid_credential_request", async () => {
        const { issuerMetadata, accessToken } =
            await prepareCredentialRequest();

        const response = await postCredential(
            issuerMetadata,
            accessToken,
            "application/jwt",
            await encrypt(issuerMetadata, "not json"),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_credential_request",
            error_description: "Decrypted credential request is not valid JSON",
        });
    });

    test("answers a decryption failure on the issuer's side with HTTP 500, without its cause", async () => {
        const { issuerMetadata, accessToken, body } =
            await prepareCredentialRequest();
        const decrypt = vi
            .spyOn(app.get(EncryptionService), "decryptJweToJson")
            .mockRejectedValueOnce(new Error("KMS unavailable"));

        try {
            const response = await postCredential(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(issuerMetadata, body),
            );

            expect(decrypt).toHaveBeenCalledOnce();
            expect(response.status).toBe(500);
            expect(response.body).not.toHaveProperty("error");
            expect(JSON.stringify(response.body)).not.toContain(
                "KMS unavailable",
            );
        } finally {
            decrypt.mockRestore();
        }
    });

    test("rejects an encrypted request whose epk cannot be imported with invalid_encryption_parameters", async () => {
        const { issuerMetadata, accessToken, body } =
            await prepareCredentialRequest();

        const response = await postCredential(
            issuerMetadata,
            accessToken,
            "application/jwt",
            withoutEpkCurve(await encrypt(issuerMetadata, body)),
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
    });

    // The request is decrypted before its credential_configuration_id is
    // checked. A JWE header the issuer refuses (OpenID4VCI 1.0 Section 10)
    // must be refused before that, so the answer does not depend on the
    // plaintext.
    const notAdvertisedKey =
        "Credential request is not encrypted to a key advertised by the issuer";
    test.each<[string, string, string, Partial<CompactJWEHeaderParameters>]>([
        [
            "the advertised alg and enc",
            "unknown_credential_configuration",
            "Credential configuration 'unknown' is not supported",
            {},
        ],
        [
            "another alg",
            "invalid_encryption_parameters",
            "Credential request JWE 'alg' must match the advertised key algorithm 'ECDH-ES'",
            { alg: "ECDH-ES+A128KW" },
        ],
        [
            "another enc",
            "invalid_encryption_parameters",
            "Credential request JWE 'enc' must be one of 'A128GCM', 'A256GCM'",
            { enc: "A128CBC-HS256" },
        ],
        [
            "no kid",
            "invalid_encryption_parameters",
            notAdvertisedKey,
            { kid: undefined },
        ],
        [
            "an unknown kid",
            "invalid_encryption_parameters",
            notAdvertisedKey,
            { kid: "unknown" },
        ],
        [
            "zip",
            "invalid_encryption_parameters",
            "Compressed credential requests are not supported",
            { zip: "DEF" },
        ],
        [
            "crit",
            "invalid_encryption_parameters",
            "Credential request JWE must not contain a critical ('crit') header parameter",
            { crit: ["x-ext"], "x-ext": true },
        ],
    ])(
        "answers an encrypted request with %s for an unknown configuration with %s",
        async (_case, error, description, header) => {
            const { issuerMetadata, accessToken, body } =
                await prepareCredentialRequest();

            const response = await postCredential(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(
                    issuerMetadata,
                    { ...body, credential_configuration_id: "unknown" },
                    header,
                ),
            );

            expect(response.status).toBe(400);
            expect(response.body).toMatchObject({
                error,
                error_description: description,
            });
        },
    );

    test("rejects a plain request that asks for an encrypted response", async () => {
        const { issuerMetadata, accessToken, body } =
            await prepareCredentialRequest();

        const response = await postCredential(
            issuerMetadata,
            accessToken,
            "application/json",
            {
                ...body,
                credential_response_encryption: (
                    await walletResponseEncryption()
                ).parameters,
            },
        );

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            error: "invalid_encryption_parameters",
        });
    });

    test("rejects a plain request when credentialRequestEncryption is set", async () => {
        const current = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({ ...current.body, credentialRequestEncryption: true })
            .expect(201);

        try {
            const { issuerMetadata, accessToken, body } =
                await prepareCredentialRequest();

            const plain = await postCredential(
                issuerMetadata,
                accessToken,
                "application/json",
                body,
            );
            expect(plain.status).toBe(400);
            expect(plain.body).toMatchObject({
                error: "invalid_encryption_parameters",
            });

            const encrypted = await postCredential(
                issuerMetadata,
                accessToken,
                "application/jwt",
                await encrypt(issuerMetadata, body),
            );
            expect(encrypted.status).toBe(200);
        } finally {
            await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(current.body)
                .expect(201);
        }
    });
});
