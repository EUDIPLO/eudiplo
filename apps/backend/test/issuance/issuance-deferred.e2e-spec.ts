import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    Jwk,
    JwtSignerJwk,
} from "@openid4vc/oauth2";
import {
    createKeyAttestationJwt,
    type IssuerMetadataResult,
    Openid4vciClient,
} from "@openid4vc/openid4vci";
import { digest } from "@owf/crypto";
import { X509Certificate } from "@peculiar/x509";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import {
    callbacks,
    getSignJwtCallback,
    IssuanceTestContext,
    setupIssuanceTestApp,
} from "../utils.js";
import {
    addX5cHeaderToKeyAttestationJwt,
    configureTrustedAttestationProvider,
    createMockTrustListJwt,
    generateSelfSignedCertificate,
} from "./attestation-trust-helpers.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

/**
 * Helper function to retrieve deferred credential.
 * The OID4VCI client library doesn't have this method yet.
 */
async function retrieveDeferredCredential(
    app: INestApplication<App>,
    issuerMetadata: IssuerMetadataResult,
    accessToken: string,
    transactionId: string,
): Promise<{ statusCode: number; body: any }> {
    // Use the deferred_credential_endpoint from issuer metadata
    const endpoint =
        issuerMetadata.credentialIssuer.deferred_credential_endpoint;
    if (!endpoint) {
        throw new Error("No deferred_credential_endpoint in issuer metadata");
    }

    // Extract the path from the endpoint URL
    const url = new URL(endpoint);
    const path = url.pathname;

    const response = await request(app.getHttpServer())
        .post(path)
        .trustLocalhost()
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
            transaction_id: transactionId,
        });

    return { statusCode: response.status, body: response.body };
}

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Issuance - Deferred Credential Flow", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let clientId: string;
    let ctx: IssuanceTestContext;

    const sdjwt = new SDJwtVcInstance({
        hasher: digest,
        hashAlg: "sha-256",
    });

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
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

    test("deferred credential issuance with webhook returning deferred response", async () => {
        const pollingInterval = 2;

        // Mock the webhook server to return a deferred response
        nock("http://localhost:8787")
            .post("/deferred", () => true)
            .reply(200, {
                deferred: true,
                interval: pollingInterval,
            });

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

        // Verify that deferred_credential_endpoint is in the metadata
        expect(
            issuerMetadata.credentialIssuer.deferred_credential_endpoint,
        ).toBeDefined();

        const { accessTokenResponse } =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });

        // Request nonce from the nonce endpoint
        const nonceResponse = await client.requestNonce({ issuerMetadata });

        const { jwt: proofJwt } = await client.createCredentialRequestJwtProof({
            issuerMetadata,
            signer: {
                method: "jwk",
                alg: "ES256",
                publicJwk: holderPublicKeyJwk,
            } as JwtSignerJwk,
            clientId,
            issuedAt: new Date(),
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            nonce: nonceResponse.c_nonce,
        });

        // Request credential using the client - should get deferred response
        const credentialResponse = await client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            issuerMetadata,
            proofs: {
                jwt: [proofJwt],
            },
        });

        // Verify we got a deferred response (transaction_id)
        expect(
            credentialResponse.credentialResponse.transaction_id,
        ).toBeDefined();
        expect(
            credentialResponse.credentialResponse.credential,
        ).toBeUndefined();

        const transactionId =
            credentialResponse.credentialResponse.transaction_id!;

        // First poll should return issuance_pending error
        const deferredResult1 = await retrieveDeferredCredential(
            app,
            issuerMetadata,
            accessTokenResponse.access_token,
            transactionId,
        );
        expect(deferredResult1.statusCode).toBe(400);
        expect(deferredResult1.body.error).toBe("issuance_pending");

        // Complete the deferred transaction via the API
        const town = "Berlin";
        await request(app.getHttpServer())
            .post(`/issuer/deferred/${transactionId}/complete`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                claims: {
                    town,
                },
            })
            .expect(200);

        // Now poll again - should return the credential
        const deferredResult2 = await retrieveDeferredCredential(
            app,
            issuerMetadata,
            accessTokenResponse.access_token,
            transactionId,
        );

        if (deferredResult2.statusCode !== 200) {
            console.log(
                "ERROR: Deferred result2:",
                JSON.stringify(deferredResult2.body, null, 2),
            );
        }
        expect(deferredResult2.statusCode).toBe(200);
        expect(deferredResult2.body.credential).toBeDefined();

        // Verify the credential claims
        const claims = await sdjwt.getClaims(
            deferredResult2.body.credential as string,
        );
        expect(claims.town).toBe(town);

        // Verify the webhook was called
        expect(nock.isDone()).toBe(true);
    });

    test("deferred credential issuance with attestation proof type", async () => {
        const trust = await configureTrustedAttestationProvider(app, authToken);
        try {
            const pollingInterval = 2;

            nock("http://localhost:8787")
                .post("/deferred-attestation", () => true)
                .reply(200, {
                    deferred: true,
                    interval: pollingInterval,
                });

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
                                url: "http://localhost:8787/deferred-attestation",
                                auth: { type: "none" },
                            },
                        },
                    },
                })
                .expect(201);

            const attestedHolderKeyPair = await generateKeyPair("ES256", {
                extractable: true,
            });
            const attestedHolderPublicJwk = await exportJWK(
                attestedHolderKeyPair.publicKey,
            );

            const attestationSignerKeyPair = trust.provider;
            const attestationSignerPrivateJwk = await exportJWK(
                attestationSignerKeyPair.privateKey,
            );
            const attestationSignerPublicJwk = await exportJWK(
                attestationSignerKeyPair.publicKey,
            );

            const client = new Openid4vciClient({
                callbacks: {
                    ...callbacks,
                    clientAuthentication: clientAuthenticationAnonymous(),
                    signJwt: getSignJwtCallback([
                        attestationSignerPrivateJwk as Jwk,
                    ]),
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

            const nonceResponse = await client.requestNonce({ issuerMetadata });

            const attestationJwt = await createKeyAttestationJwt({
                callbacks: {
                    ...callbacks,
                    signJwt: getSignJwtCallback([
                        attestationSignerPrivateJwk as Jwk,
                    ]),
                },
                signer: {
                    method: "jwk",
                    alg: "ES256",
                    publicJwk: attestationSignerPublicJwk,
                } as JwtSignerJwk,
                issuedAt: new Date(),
                use: "proof_type.attestation",
                attestedKeys: [attestedHolderPublicJwk as Jwk],
                nonce: nonceResponse.c_nonce,
            });

            const credentialResponse = await client.retrieveCredentials({
                accessToken: accessTokenResponse.access_token,
                credentialConfigurationId:
                    credentialOffer.credential_configuration_ids[0],
                issuerMetadata,
                proofs: {
                    attestation: [
                        await addX5cHeaderToKeyAttestationJwt(
                            attestationJwt,
                            trust.provider.privateKey,
                            trust.provider.certificate,
                        ),
                    ],
                },
            });

            expect(
                credentialResponse.credentialResponse.transaction_id,
            ).toBeDefined();
            expect(
                credentialResponse.credentialResponse.credential,
            ).toBeUndefined();

            const transactionId =
                credentialResponse.credentialResponse.transaction_id!;

            const deferredResult1 = await retrieveDeferredCredential(
                app,
                issuerMetadata,
                accessTokenResponse.access_token,
                transactionId,
            );
            expect(deferredResult1.statusCode).toBe(400);
            expect(deferredResult1.body.error).toBe("issuance_pending");

            const town = "Hamburg";
            await request(app.getHttpServer())
                .post(`/issuer/deferred/${transactionId}/complete`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    claims: {
                        town,
                    },
                })
                .expect(200);

            const deferredResult2 = await retrieveDeferredCredential(
                app,
                issuerMetadata,
                accessTokenResponse.access_token,
                transactionId,
            );
            expect(deferredResult2.statusCode).toBe(200);
            expect(deferredResult2.body.credential).toBeDefined();

            const claims = await sdjwt.getClaims(
                deferredResult2.body.credential as string,
            );
            expect(claims.town).toBe(town);

            expect(nock.isDone()).toBe(true);
        } finally {
            await trust.restore();
        }
    });

    test("deferred credential - invalid transaction_id", async () => {
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const _holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);

        // Create an offer just to get a valid access token
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                flow: "pre_authorized_code",
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
            })
            .expect(201);

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

        // Try to get a deferred credential with an invalid transaction_id
        const result = await retrieveDeferredCredential(
            app,
            issuerMetadata,
            accessTokenResponse.access_token,
            "invalid-transaction-id",
        );
        expect(result.statusCode).toBe(400);
        expect(result.body.error).toBe("invalid_transaction_id");
    });

    test("deferred credential - transaction already retrieved", async () => {
        const pollingInterval = 2;

        // Mock the webhook server to return a deferred response
        nock("http://localhost:8787")
            .post("/deferred-retrieved", () => true)
            .reply(200, {
                deferred: true,
                interval: pollingInterval,
            });

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
                            url: "http://localhost:8787/deferred-retrieved",
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

        const nonceResponse = await client.requestNonce({ issuerMetadata });

        const { jwt: proofJwt } = await client.createCredentialRequestJwtProof({
            issuerMetadata,
            signer: {
                method: "jwk",
                alg: "ES256",
                publicJwk: holderPublicKeyJwk,
            } as JwtSignerJwk,
            clientId,
            issuedAt: new Date(),
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            nonce: nonceResponse.c_nonce,
        });

        // Request credential - should get deferred response
        const credentialResponse = await client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            issuerMetadata,
            proofs: {
                jwt: [proofJwt],
            },
        });

        const transactionId =
            credentialResponse.credentialResponse.transaction_id!;

        // Complete the deferred transaction
        await request(app.getHttpServer())
            .post(`/issuer/deferred/${transactionId}/complete`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                claims: { town: "Munich" },
            })
            .expect(200);

        // First retrieval should succeed
        const firstRetrieval = await retrieveDeferredCredential(
            app,
            issuerMetadata,
            accessTokenResponse.access_token,
            transactionId,
        );
        expect(firstRetrieval.statusCode).toBe(200);
        expect(firstRetrieval.body.credential).toBeDefined();

        // Second retrieval should fail with invalid_transaction_id (already retrieved)
        const secondRetrieval = await retrieveDeferredCredential(
            app,
            issuerMetadata,
            accessTokenResponse.access_token,
            transactionId,
        );
        expect(secondRetrieval.statusCode).toBe(400);
        expect(secondRetrieval.body.error).toBe("invalid_transaction_id");
    });

    test("deferred credential - failed transaction", async () => {
        // Mock the webhook server to return a deferred response
        nock("http://localhost:8787")
            .post("/deferred-fail", () => true)
            .reply(200, {
                deferred: true,
                interval: 2,
            });

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
                            url: "http://localhost:8787/deferred-fail",
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

        const nonceResponse = await client.requestNonce({ issuerMetadata });

        const { jwt: proofJwt } = await client.createCredentialRequestJwtProof({
            issuerMetadata,
            signer: {
                method: "jwk",
                alg: "ES256",
                publicJwk: holderPublicKeyJwk,
            } as JwtSignerJwk,
            clientId,
            issuedAt: new Date(),
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            nonce: nonceResponse.c_nonce,
        });

        // Request credential - should get deferred response
        const credentialResponse = await client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            issuerMetadata,
            proofs: {
                jwt: [proofJwt],
            },
        });

        const transactionId =
            credentialResponse.credentialResponse.transaction_id!;

        // Fail the deferred transaction
        const errorMessage = "KYC verification failed";
        await request(app.getHttpServer())
            .post(`/issuer/deferred/${transactionId}/fail`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                error: errorMessage,
            })
            .expect(200);

        // Poll should return invalid_transaction_id with error message
        const result = await retrieveDeferredCredential(
            app,
            issuerMetadata,
            accessTokenResponse.access_token,
            transactionId,
        );
        expect(result.statusCode).toBe(400);
        expect(result.body.error).toBe("invalid_transaction_id");
    });

    test("deferred: rejects attestation proof without x5c when trust list is configured", async () => {
        const trustListUrl =
            "http://localhost:8787/deferred-key-attestation-trust-list";
        const trustListSigningCert = await generateSelfSignedCertificate();
        const currentConfig = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...currentConfig.body,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
            } as IssuanceDto)
            .expect(201);

        try {
            nock("http://localhost:8787")
                .post("/deferred-no-x5c", () => true)
                .reply(200, { deferred: true, interval: 2 });

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
                                url: "http://localhost:8787/deferred-no-x5c",
                                auth: { type: "none" },
                            },
                        },
                    },
                })
                .expect(201);

            const attestationSignerKeyPair = await generateKeyPair("ES256", {
                extractable: true,
            });
            const attestationSignerPrivateJwk = await exportJWK(
                attestationSignerKeyPair.privateKey,
            );
            const attestationSignerPublicJwk = await exportJWK(
                attestationSignerKeyPair.publicKey,
            );
            const attestedHolderKeyPair = await generateKeyPair("ES256", {
                extractable: true,
            });
            const attestedHolderPublicJwk = await exportJWK(
                attestedHolderKeyPair.publicKey,
            );

            const client = new Openid4vciClient({
                callbacks: {
                    ...callbacks,
                    clientAuthentication: clientAuthenticationAnonymous(),
                    signJwt: getSignJwtCallback([
                        attestationSignerPrivateJwk as Jwk,
                    ]),
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
            const nonceResponse = await client.requestNonce({ issuerMetadata });

            // Create attestation JWT without x5c
            const attestationJwt = await createKeyAttestationJwt({
                callbacks: {
                    ...callbacks,
                    signJwt: getSignJwtCallback([
                        attestationSignerPrivateJwk as Jwk,
                    ]),
                },
                signer: {
                    method: "jwk",
                    alg: "ES256",
                    publicJwk: attestationSignerPublicJwk,
                } as JwtSignerJwk,
                issuedAt: new Date(),
                use: "proof_type.attestation",
                attestedKeys: [attestedHolderPublicJwk as Jwk],
                nonce: nonceResponse.c_nonce,
            });

            await expect(
                client.retrieveCredentials({
                    accessToken: accessTokenResponse.access_token,
                    credentialConfigurationId:
                        credentialOffer.credential_configuration_ids[0],
                    issuerMetadata,
                    proofs: { attestation: [attestationJwt] },
                }),
            ).rejects.toThrow(
                "Attestation proof must contain an x5c certificate chain for trust validation",
            );
        } finally {
            await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send(currentConfig.body as IssuanceDto)
                .expect(201);
        }
    });

    test.each(["jwt", "attestation"] as const)(
        "deferred: enforces configured trust list for attestation proof x5c chains (%s)",
        async (proofType) => {
            const trustListUrl =
                "http://localhost:8787/deferred-key-attestation-trust-list-chain";
            const trustListSigningCert = await generateSelfSignedCertificate();
            const currentConfig = await request(app.getHttpServer())
                .get("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

            await request(app.getHttpServer())
                .post("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    ...currentConfig.body,
                    walletProviderTrustLists: [
                        {
                            url: trustListUrl,
                            verifierX509Der:
                                trustListSigningCert.certificate.toString(
                                    "base64",
                                ),
                        },
                    ],
                } as IssuanceDto)
                .expect(201);

            try {
                const trustedWalletProviderCert =
                    await generateSelfSignedCertificate();
                const untrustedWalletProviderCert =
                    await generateSelfSignedCertificate();
                const trustListJwt = await createMockTrustListJwt(
                    trustListSigningCert,
                    trustedWalletProviderCert.certificate,
                );

                nock("http://localhost:8787")
                    .persist()
                    .get("/deferred-key-attestation-trust-list-chain")
                    .reply(200, trustListJwt, {
                        "Content-Type": "application/jwt",
                    });

                const deferredIssuanceWithAttestation = async (
                    attestationCert: {
                        certificate: X509Certificate;
                        privateKey: CryptoKey;
                        publicKey: CryptoKey;
                    },
                    expectSuccess: boolean,
                ) => {
                    nock("http://localhost:8787")
                        .post("/deferred-chain-test", () => true)
                        .reply(200, { deferred: true, interval: 2 });

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
                                        url: "http://localhost:8787/deferred-chain-test",
                                        auth: { type: "none" },
                                    },
                                },
                            },
                        })
                        .expect(201);

                    const attestationSignerPrivateJwk = await exportJWK(
                        attestationCert.privateKey,
                    );
                    const attestationSignerPublicJwk = await exportJWK(
                        attestationCert.publicKey,
                    );
                    const attestedHolderKeyPair = await generateKeyPair(
                        "ES256",
                        {
                            extractable: true,
                        },
                    );
                    const attestedHolderPublicJwk = await exportJWK(
                        attestedHolderKeyPair.publicKey,
                    );

                    const client = new Openid4vciClient({
                        callbacks: {
                            ...callbacks,
                            clientAuthentication:
                                clientAuthenticationAnonymous(),
                        },
                    });
                    const credentialOffer = await client.resolveCredentialOffer(
                        offerResponse.body.uri,
                    );
                    const issuerMetadata = await client.resolveIssuerMetadata(
                        credentialOffer.credential_issuer,
                    );
                    const { accessTokenResponse } =
                        await client.retrievePreAuthorizedCodeAccessTokenFromOffer(
                            {
                                credentialOffer,
                                issuerMetadata,
                            },
                        );
                    const nonceResponse = await client.requestNonce({
                        issuerMetadata,
                    });

                    const attestationJwt = await createKeyAttestationJwt({
                        callbacks: {
                            ...callbacks,
                            signJwt: getSignJwtCallback([
                                attestationSignerPrivateJwk as Jwk,
                            ]),
                        },
                        signer: {
                            method: "jwk",
                            alg: "ES256",
                            publicJwk: attestationSignerPublicJwk,
                        } as JwtSignerJwk,
                        issuedAt: new Date(),
                        use:
                            proofType === "jwt"
                                ? "proof_type.jwt"
                                : "proof_type.attestation",
                        expiresAt: new Date(Date.now() + 300_000),
                        attestedKeys: [attestedHolderPublicJwk as Jwk],
                        nonce: nonceResponse.c_nonce,
                    });

                    const attestationJwtWithX5c =
                        await addX5cHeaderToKeyAttestationJwt(
                            attestationJwt,
                            attestationCert.privateKey,
                            attestationCert.certificate,
                        );

                    const proofs =
                        proofType === "jwt"
                            ? {
                                  jwt: [
                                      await new SignJWT({
                                          nonce: nonceResponse.c_nonce,
                                      })
                                          .setProtectedHeader({
                                              alg: "ES256",
                                              typ: "openid4vci-proof+jwt",
                                              jwk: attestedHolderPublicJwk,
                                              key_attestation:
                                                  attestationJwtWithX5c,
                                          })
                                          .setAudience(
                                              credentialOffer.credential_issuer,
                                          )
                                          .setIssuedAt()
                                          .sign(
                                              attestedHolderKeyPair.privateKey,
                                          ),
                                  ],
                              }
                            : { attestation: [attestationJwtWithX5c] };

                    if (expectSuccess) {
                        const credentialResponse =
                            await client.retrieveCredentials({
                                accessToken: accessTokenResponse.access_token,
                                credentialConfigurationId:
                                    credentialOffer
                                        .credential_configuration_ids[0],
                                issuerMetadata,
                                proofs,
                            });
                        expect(
                            credentialResponse.credentialResponse
                                .transaction_id,
                        ).toBeDefined();
                    } else {
                        await expect(
                            client.retrieveCredentials({
                                accessToken: accessTokenResponse.access_token,
                                credentialConfigurationId:
                                    credentialOffer
                                        .credential_configuration_ids[0],
                                issuerMetadata,
                                proofs,
                            }),
                        ).rejects.toThrow();
                    }
                };

                // Untrusted signer → should be rejected
                await deferredIssuanceWithAttestation(
                    untrustedWalletProviderCert,
                    false,
                );
                // Trusted signer → deferred response (transaction_id returned)
                await deferredIssuanceWithAttestation(
                    trustedWalletProviderCert,
                    true,
                );
            } finally {
                await request(app.getHttpServer())
                    .post("/issuer/config")
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send(currentConfig.body as IssuanceDto)
                    .expect(201);
            }
        },
    );
});
