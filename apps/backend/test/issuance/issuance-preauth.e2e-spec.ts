import "reflect-metadata";
import { readFileSync } from "node:fs";
import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    createDpopHeadersForRequest,
    Jwk,
    JwtSignerJwk,
} from "@openid4vc/oauth2";
import {
    createKeyAttestationJwt,
    type NotificationEvent,
    Openid4vciClient,
    type Openid4vciRetrieveCredentialsError,
} from "@openid4vc/openid4vci";
import { digest } from "@owf/crypto";
import { X509Certificate } from "@peculiar/x509";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { DataSource } from "typeorm";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { buildClaims } from "../../src/issuer/configuration/credentials/utils/derive.js";
import { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { Session } from "../../src/session/entities/session.entity.js";
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

async function resolveCredentialOffer(offerUri: string): Promise<any> {
    const client = new Openid4vciClient({
        callbacks: {
            ...callbacks,
            clientAuthentication: clientAuthenticationAnonymous(),
        },
    });

    return client.resolveCredentialOffer(offerUri);
}

/** Request body that nock passed to a reply function, as JSON. */
function asJson(body: unknown): unknown {
    return typeof body === "string" ? JSON.parse(body) : body;
}

describe("Issuance - Pre-authorized Code Flow", () => {
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

    test("pre authorized code flow", async () => {
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

        console.log(credentialOffer.credential_issuer);

        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );

        const { accessTokenResponse } =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });

        // Request nonce from the nonce endpoint (OID4VCI spec)
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

        const credentialResponse = await client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            issuerMetadata,
            proofs: {
                jwt: [proofJwt],
            },
        });
        await client.sendNotification({
            issuerMetadata,
            notification: {
                notificationId:
                    credentialResponse.credentialResponse.notification_id!,
                event: "credential_accepted",
            },
            accessToken: accessTokenResponse.access_token,
        });
        const session = await request(app.getHttpServer())
            .get(`/session/${offerResponse.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`);
        const notificationObj = session.body.notifications.find(
            (notification: any) =>
                notification.id ===
                credentialResponse.credentialResponse.notification_id,
        );
        expect(notificationObj).toBeDefined();
        expect(notificationObj.event).toBe("credential_accepted");

        // A notification_id that was not issued in the token's session
        const unknownNotification = await request(app.getHttpServer())
            .post(
                new URL(issuerMetadata.credentialIssuer.notification_endpoint!)
                    .pathname,
            )
            .trustLocalhost()
            .set("Authorization", `Bearer ${accessTokenResponse.access_token}`)
            .send({ notification_id: "unknown", event: "credential_accepted" });
        expect(unknownNotification.status).toBe(400);
        expect(unknownNotification.body).toMatchObject({
            error: "invalid_notification_id",
        });
    });

    test("rejects a replayed DPoP proof at the credential endpoint", async () => {
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
        const signJwt = getSignJwtCallback([holderPrivateKeyJwk as Jwk]);
        const holderSigner = {
            method: "jwk",
            alg: "ES256",
            publicJwk: holderPublicKeyJwk,
        } as JwtSignerJwk;

        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt,
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
                dpop: { signer: holderSigner },
            });
        expect(accessTokenResponse.token_type).toBe("DPoP");
        const accessToken = accessTokenResponse.access_token;

        const credentialEndpoint =
            issuerMetadata.credentialIssuer.credential_endpoint;
        const { DPoP: dpopProof } = await createDpopHeadersForRequest({
            request: { method: "POST", url: credentialEndpoint },
            signer: holderSigner,
            accessToken,
            callbacks: { ...callbacks, signJwt },
        });

        // Each request carries a fresh key proof, so only the DPoP proof repeats.
        const credentialRequest = async () => {
            const { c_nonce } = await client.requestNonce({ issuerMetadata });
            const { jwt } = await client.createCredentialRequestJwtProof({
                issuerMetadata,
                signer: holderSigner,
                clientId,
                issuedAt: new Date(),
                credentialConfigurationId:
                    credentialOffer.credential_configuration_ids[0],
                nonce: c_nonce,
            });
            return request(app.getHttpServer())
                .post(new URL(credentialEndpoint).pathname)
                .trustLocalhost()
                .set("Authorization", `DPoP ${accessToken}`)
                .set("DPoP", dpopProof)
                .send({
                    credential_configuration_id:
                        credentialOffer.credential_configuration_ids[0],
                    proofs: { jwt: [jwt] },
                });
        };

        const first = await credentialRequest();
        expect(first.status).toBe(200);
        expect(first.body.credentials).toHaveLength(1);

        const replay = await credentialRequest();
        expect(replay.status).toBe(401);
        expect(replay.headers["www-authenticate"]).toContain("DPoP");
        expect(replay.body).toMatchObject({
            error: "invalid_token",
            error_description: expect.stringContaining("has already been used"),
        });
    });

    test.each([
        [
            "notification",
            { notification_id: "n", event: "credential_accepted" },
        ],
        ["deferred_credential", { transaction_id: "t" }],
    ])(
        "answers an invalid access token at the %s endpoint with 401",
        async (endpoint, body) => {
            const response = await request(app.getHttpServer())
                .post(`/issuers/root/vci/${endpoint}`)
                .trustLocalhost()
                .set("Authorization", "Bearer not-a-valid-token")
                .send(body);
            expect(response.status).toBe(401);
            expect(response.body).toMatchObject({ error: "invalid_token" });
            expect(response.headers["www-authenticate"]).toBeDefined();
        },
    );

    test("rejects a pre-authorized code after the session lifetime", async () => {
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

        // Backdate the session beyond the default session TTL (24 h).
        await app
            .get(DataSource)
            .getRepository(Session)
            .update(offerResponse.body.session, {
                createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
            });

        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        });
        const credentialOffer = await client.resolveCredentialOffer(
            offerResponse.body.uri,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );
        const error = await client
            .retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            })
            .then(
                () => undefined,
                (err) => err.errorResponse,
            );
        expect(error).toMatchObject({
            error: "invalid_grant",
            error_description: "Expired 'pre-authorized_code' provided",
        });
    });

    test("locks the pre-authorized code after repeated wrong tx_code attempts", async () => {
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
                tx_code: "1234",
            })
            .expect(201);

        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        });
        const credentialOffer = await client.resolveCredentialOffer(
            offerResponse.body.uri,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );
        const tokenError = (txCode: string) =>
            client
                .retrievePreAuthorizedCodeAccessTokenFromOffer({
                    credentialOffer,
                    issuerMetadata,
                    txCode,
                })
                .then(
                    () => undefined,
                    (error) => error.errorResponse,
                );

        const lockedDescription =
            "Too many failed tx_code attempts. The pre-authorized code has been invalidated.";
        const responses: Array<{ error?: string; error_description?: string }> =
            [];
        // The default limit is 5 attempts; stop as soon as the code is locked.
        for (let attempt = 0; attempt < 10; attempt++) {
            const response = await tokenError("0000");
            responses.push(response);
            if (response?.error_description === lockedDescription) break;
        }

        expect(responses.at(-1)).toMatchObject({
            error: "invalid_grant",
            error_description: lockedDescription,
        });
        expect(responses.length).toBeLessThan(10);
        for (const response of responses.slice(0, -1)) {
            expect(response).toMatchObject({ error: "invalid_grant" });
        }
        // Once locked, even the correct transaction code is rejected.
        await expect(tokenError("1234")).resolves.toMatchObject({
            error: "invalid_grant",
            error_description: lockedDescription,
        });
    });

    test("pre authorized code flow with attestation proof type", async () => {
        const trust = await configureTrustedAttestationProvider(app, authToken);
        try {
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

            const attestationSignerKeyPair = trust.provider;
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
                credentialResponse.credentialResponse.credentials,
            ).toBeDefined();
            expect(
                credentialResponse.credentialResponse.credentials?.length,
            ).toBeGreaterThan(0);
        } finally {
            await trust.restore();
        }
    });

    test("rejects credential request containing both jwt and attestation proofs", async () => {
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

        const attestationSignerKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
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
            attestedKeys: [holderPublicKeyJwk as Jwk],
            nonce: nonceResponse.c_nonce,
        });

        await expect(
            client.retrieveCredentials({
                accessToken: accessTokenResponse.access_token,
                credentialConfigurationId:
                    credentialOffer.credential_configuration_ids[0],
                issuerMetadata,
                proofs: {
                    jwt: [proofJwt],
                    attestation: [attestationJwt],
                },
            }),
        ).rejects.toThrow();
    });

    test("rejects attestation proof without x5c when trust list validation is configured", async () => {
        const trustListUrl = "http://localhost:8787/key-attestation-trust-list";
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
                    proofs: {
                        attestation: [attestationJwt],
                    },
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
        "enforces configured trust list for attestation proof x5c chains (%s)",
        async (proofType) => {
            const trustListUrl =
                "http://localhost:8787/key-attestation-trust-list";
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
                    .get("/key-attestation-trust-list")
                    .reply(200, trustListJwt, {
                        "Content-Type": "application/jwt",
                    });

                const issueCredentialWithAttestation = async (attestationCert: {
                    certificate: X509Certificate;
                    privateKey: CryptoKey;
                    publicKey: CryptoKey;
                }) => {
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

                    return client.retrieveCredentials({
                        accessToken: accessTokenResponse.access_token,
                        credentialConfigurationId:
                            credentialOffer.credential_configuration_ids[0],
                        issuerMetadata,
                        proofs,
                    });
                };

                await expect(
                    issueCredentialWithAttestation(untrustedWalletProviderCert),
                ).rejects.toThrow();

                const credentialResponse = await issueCredentialWithAttestation(
                    trustedWalletProviderCert,
                );
                expect(
                    credentialResponse.credentialResponse.credentials?.length,
                ).toBeGreaterThan(0);
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

    test("enforces attestation-only proof policy per credential config", async () => {
        const baseConfigResponse = await request(app.getHttpServer())
            .get("/issuer/credentials/pid-no-key")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const attestationOnlyConfigId = `pid-attestation-only-${Date.now()}`;
        const baseConfig = baseConfigResponse.body;

        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: attestationOnlyConfigId,
                description: baseConfig.description,
                config: {
                    ...baseConfig.config,
                    proofTypesSupported: ["attestation"],
                },
                fields: baseConfig.fields,
                attributeProviderId: baseConfig.attributeProviderId,
                webhookEndpointId: baseConfig.webhookEndpointId,
                vct: baseConfig.vct,
                keyBinding: baseConfig.keyBinding,
                keyChainId: baseConfig.keyChainId,
                embeddedDisclosurePolicy: baseConfig.embeddedDisclosurePolicy,
                schemaMeta: baseConfig.schemaMeta,
                iaeActions: baseConfig.iaeActions,
            })
            .expect(201);

        try {
            const offerResponse = await request(app.getHttpServer())
                .post("/issuer/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: "uri",
                    credentialConfigurationIds: [attestationOnlyConfigId],
                    flow: "pre_authorized_code",
                })
                .expect(201);

            const holderKeyPair = await generateKeyPair("ES256", {
                extractable: true,
            });
            const holderPrivateKeyJwk = await exportJWK(
                holderKeyPair.privateKey,
            );
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

            const supportedConfig =
                issuerMetadata.credentialIssuer
                    .credential_configurations_supported[
                    attestationOnlyConfigId
                ];
            expect(
                supportedConfig.proof_types_supported.attestation,
            ).toBeDefined();
            expect(supportedConfig.proof_types_supported.jwt).toBeUndefined();

            const nonceResponse = await client.requestNonce({ issuerMetadata });

            await expect(
                client.createCredentialRequestJwtProof({
                    issuerMetadata,
                    signer: {
                        method: "jwk",
                        alg: "ES256",
                        publicJwk: holderPublicKeyJwk,
                    } as JwtSignerJwk,
                    clientId,
                    issuedAt: new Date(),
                    credentialConfigurationId: attestationOnlyConfigId,
                    nonce: nonceResponse.c_nonce,
                }),
            ).rejects.toThrow();
        } finally {
            const deleteResponse = await request(app.getHttpServer())
                .delete(`/issuer/credentials/${attestationOnlyConfigId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`);

            expect([200, 204]).toContain(deleteResponse.status);
        }
    });

    test("enforces the key attestation requirements of the credential configuration", async () => {
        const trust = await configureTrustedAttestationProvider(app, authToken);
        const baseConfig = (
            await request(app.getHttpServer())
                .get("/issuer/credentials/pid-no-key")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200)
        ).body;
        const configId = `pid-key-attestation-${Date.now()}`;
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: configId,
                description: baseConfig.description,
                config: {
                    ...baseConfig.config,
                    proofTypesSupported: ["attestation", "jwt"],
                    keyAttestationsRequired: {
                        key_storage: ["iso_18045_high"],
                    },
                },
                fields: baseConfig.fields,
                attributeProviderId: baseConfig.attributeProviderId,
                webhookEndpointId: baseConfig.webhookEndpointId,
                vct: baseConfig.vct,
                keyBinding: baseConfig.keyBinding,
                keyChainId: baseConfig.keyChainId,
                embeddedDisclosurePolicy: baseConfig.embeddedDisclosurePolicy,
                schemaMeta: baseConfig.schemaMeta,
                iaeActions: baseConfig.iaeActions,
            })
            .expect(201);

        const providerPrivateJwk = await exportJWK(trust.provider.privateKey);
        const providerPublicJwk = await exportJWK(trust.provider.publicKey);

        /** Run a pre-authorized flow and send the proofs built for its nonce. */
        const requestCredential = async (
            proofType: "jwt" | "attestation",
            keyStorage?: string[],
        ) => {
            const offerResponse = await request(app.getHttpServer())
                .post("/issuer/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: "uri",
                    credentialConfigurationIds: [configId],
                    flow: "pre_authorized_code",
                })
                .expect(201);
            const client = new Openid4vciClient({
                callbacks: {
                    ...callbacks,
                    clientAuthentication: clientAuthenticationAnonymous(),
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
            const { c_nonce: nonce } = await client.requestNonce({
                issuerMetadata,
            });
            const holder = await generateKeyPair("ES256", {
                extractable: true,
            });
            const holderPublicJwk = await exportJWK(holder.publicKey);

            const keyAttestation = keyStorage
                ? await addX5cHeaderToKeyAttestationJwt(
                      await createKeyAttestationJwt({
                          callbacks: {
                              ...callbacks,
                              signJwt: getSignJwtCallback([
                                  providerPrivateJwk as Jwk,
                              ]),
                          },
                          signer: {
                              method: "jwk",
                              alg: "ES256",
                              publicJwk: providerPublicJwk,
                          } as JwtSignerJwk,
                          issuedAt: new Date(),
                          expiresAt: new Date(Date.now() + 300_000),
                          use:
                              proofType === "jwt"
                                  ? "proof_type.jwt"
                                  : "proof_type.attestation",
                          attestedKeys: [holderPublicJwk as Jwk],
                          keyStorage,
                          nonce,
                      }),
                      trust.provider.privateKey,
                      trust.provider.certificate,
                  )
                : undefined;
            const proofs =
                proofType === "attestation"
                    ? { attestation: [keyAttestation!] }
                    : {
                          jwt: [
                              await new SignJWT({ nonce })
                                  .setProtectedHeader({
                                      alg: "ES256",
                                      typ: "openid4vci-proof+jwt",
                                      jwk: holderPublicJwk,
                                      ...(keyAttestation && {
                                          key_attestation: keyAttestation,
                                      }),
                                  })
                                  .setAudience(
                                      credentialOffer.credential_issuer,
                                  )
                                  .setIssuedAt()
                                  .sign(holder.privateKey),
                          ],
                      };
            return client.retrieveCredentials({
                accessToken: accessTokenResponse.access_token,
                credentialConfigurationId: configId,
                issuerMetadata,
                proofs,
            });
        };
        const errorOf = (promise: Promise<unknown>) =>
            promise.then(
                () => {
                    throw new Error("Expected the credential request to fail");
                },
                (error: Openid4vciRetrieveCredentialsError) =>
                    error.response.credentialErrorResponseResult?.data,
            );

        try {
            await expect(errorOf(requestCredential("jwt"))).resolves.toEqual({
                error: "invalid_proof",
                error_description: expect.stringContaining(
                    "requires a key attestation",
                ),
            });
            await expect(
                errorOf(
                    requestCredential("attestation", ["iso_18045_moderate"]),
                ),
            ).resolves.toEqual({
                error: "invalid_proof",
                error_description: expect.stringContaining("key_storage"),
            });
            await expect(
                errorOf(requestCredential("jwt", ["iso_18045_moderate"])),
            ).resolves.toMatchObject({ error: "invalid_proof" });

            for (const proofType of ["jwt", "attestation"] as const) {
                const response = await requestCredential(proofType, [
                    "iso_18045_high",
                ]);
                expect(
                    response.credentialResponse.credentials?.length,
                ).toBeGreaterThan(0);
            }
        } finally {
            await request(app.getHttpServer())
                .delete(`/issuer/credentials/${configId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`);
            await trust.restore();
        }
    });

    test("pre auth flow with webhook claims", async () => {
        const town = "Köln";
        // Mock the webhook server response
        nock("http://localhost:8787")
            .post("/request", () => true)
            .reply(200, {
                citizen: {
                    town,
                },
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
                            url: "http://localhost:8787/request",
                            auth: { type: "none" },
                        },
                    },
                },
            })
            .expect(201);

        const claims = await getClaims(offerResponse);
        expect(claims).toBeDefined();
        expect(claims.town).toBe(town);

        // Verify the webhook was called
        expect(nock.isDone()).toBe(true);
    });

    test("pre auth flow with passed claims", async () => {
        const town = "Hamburg";

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
                        type: "inline",
                        claims: {
                            town,
                        },
                    },
                },
            })
            .expect(201);

        const claims = await getClaims(offerResponse);
        expect(claims).toBeDefined();
        expect(claims.town).toBe(town);

        // Verify the webhook was called
        expect(nock.isDone()).toBe(true);
    });

    test("rejects webhook claims that miss a required claim", async () => {
        nock("http://localhost:8787")
            .post("/request", () => true)
            .reply(200, { citizen: {} });

        const offerResponse = await createWebhookOffer("citizen");

        expect(await getCredentialErrorResponse(offerResponse)).toMatchObject({
            error: "credential_request_denied",
            error_description: expect.stringContaining(
                "/town: missing required claim",
            ),
        });
    });

    test("rejects webhook claims with an unexpected claim", async () => {
        nock("http://localhost:8787")
            .post("/request", () => true)
            .reply(200, { citizen: { town: "Köln", nickname: "Kölsche" } });

        const offerResponse = await createWebhookOffer("citizen");
        const errorResponse = await getCredentialErrorResponse(offerResponse);

        expect(errorResponse).toMatchObject({
            error: "credential_request_denied",
            error_description: expect.stringContaining(
                "/nickname: unexpected claim",
            ),
        });
        expect(errorResponse?.error_description).not.toContain("Kölsche");
    });

    test("rejects webhook claims with an invalid nested claim", async () => {
        const fixture = JSON.parse(
            readFileSync(
                new URL(
                    "../fixtures/haip/issuance/credentials/pid-no-key.json",
                    import.meta.url,
                ),
                "utf-8",
            ),
        );
        const claims = buildClaims(fixture.spec.fields) as Record<string, any>;
        claims.address.street_address = 42;
        nock("http://localhost:8787")
            .post("/request", () => true)
            .reply(200, { "pid-no-key": claims });

        const offerResponse = await createWebhookOffer("pid-no-key");

        expect(await getCredentialErrorResponse(offerResponse)).toMatchObject({
            error: "credential_request_denied",
            error_description: expect.stringContaining(
                "/address/street_address: must be string",
            ),
        });
    });

    test("rejects inline claims with a wrong type when creating the offer", async () => {
        await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                flow: "pre_authorized_code",
                response_type: "uri",
                credentialConfigurationIds: ["citizen"],
                credentialClaims: {
                    citizen: { type: "inline", claims: { town: 5 } },
                },
            })
            .expect(409)
            .expect((res) => {
                expect(res.body.message).toContain("/town: must be string");
            });
    });

    test("rejects a webhook answer without claims for the credential configuration", async () => {
        const claimRequests: unknown[] = [];
        nock("http://localhost:8787")
            .post("/request")
            .times(2)
            .reply((_uri, body) => {
                claimRequests.push(asJson(body));
                return [200, { other: { town: "Köln" } }];
            });

        const offerResponse = await createWebhookOffer("citizen");

        expect(await getCredentialErrorResponse(offerResponse)).toEqual({
            error: "credential_request_denied",
            error_description:
                "The claim source returned no claims for credential configuration 'citizen'",
        });
        // One claims request; no second call and no static default.
        expect(claimRequests).toEqual([
            expect.objectContaining({ credential_configuration_id: "citizen" }),
        ]);
    });

    test("issues the static defaults without a claim source", async () => {
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                flow: "pre_authorized_code",
                response_type: "uri",
                credentialConfigurationIds: ["citizen"],
            })
            .expect(201);

        expect((await getClaims(offerResponse)).town).toBe("BERLIN");
    });

    test("pre-authorized flow defaults to built-in authorization server", async () => {
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

        const credentialOffer = await resolveCredentialOffer(
            offerResponse.body.uri,
        );
        const preAuthGrant =
            credentialOffer.grants?.[
                "urn:ietf:params:oauth:grant-type:pre-authorized_code"
            ];

        expect(preAuthGrant?.authorization_server).toBe(
            credentialOffer.credential_issuer,
        );
    });

    test("pre-authorized flow accepts built-in authorization server override", async () => {
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
                authorization_server: "issuer-built-in",
            })
            .expect(201);

        const credentialOffer = await resolveCredentialOffer(
            offerResponse.body.uri,
        );
        const preAuthGrant =
            credentialOffer.grants?.[
                "urn:ietf:params:oauth:grant-type:pre-authorized_code"
            ];

        expect(preAuthGrant?.authorization_server).toBe(
            credentialOffer.credential_issuer,
        );
    });

    describe("notification webhook", () => {
        const receiver = "http://localhost:8787";

        beforeAll(async () => {
            await request(app.getHttpServer())
                .post("/issuer/webhook-endpoints")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    id: "issuance-events",
                    name: "Issuance events",
                    url: `${receiver}/notify`,
                    auth: { type: "none" },
                })
                .expect(201);
        });

        function createNotifyingOffer() {
            return request(app.getHttpServer())
                .post("/issuer/offer")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                    webhookEndpointId: "issuance-events",
                    reference: "order-4711",
                })
                .expect(201);
        }

        function getSession(id: string) {
            return request(app.getHttpServer())
                .get(`/session/${id}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);
        }

        test("completes the session although the delivery fails", async () => {
            const delivery = nock(receiver).post("/notify").reply(500);
            const offerResponse = await createNotifyingOffer();
            const { notify } = await retrieveCredentials(offerResponse);

            // Answers the wallet with success instead of 500.
            await notify("credential_accepted");

            expect(delivery.isDone()).toBe(true);
            const session = await getSession(offerResponse.body.session);
            expect(session.body.status).toBe("completed");
            expect(session.body.notifications).toEqual([
                expect.objectContaining({ event: "credential_accepted" }),
            ]);
        });

        test("forwards the event description and the reference", async () => {
            const payloads: unknown[] = [];
            nock(receiver)
                .post("/notify")
                .reply((_uri, body) => {
                    payloads.push(asJson(body));
                    return [204, ""];
                });
            const offerResponse = await createNotifyingOffer();
            const { credentialResponse, notify } =
                await retrieveCredentials(offerResponse);

            await notify("credential_failure", "Could not store: [E42]");

            const notification = {
                id: credentialResponse.notification_id,
                credentialConfigurationId: "pid-no-key",
                event: "credential_failure",
                eventDescription: "Could not store: [E42]",
            };
            expect(payloads).toEqual([
                {
                    notification,
                    session: offerResponse.body.session,
                    reference: "order-4711",
                },
            ]);
            const session = await getSession(offerResponse.body.session);
            expect(session.body.status).toBe("failed");
            expect(session.body.notifications).toEqual([notification]);
        });
    });

    async function retrieveCredentials(offerResponse: any) {
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

        // Request nonce from the nonce endpoint (OID4VCI spec)
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

        const response = await client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            issuerMetadata,
            proofs: {
                jwt: [proofJwt],
            },
        });
        // Sends the wallet's notification for the issued credential.
        const notify = (event: NotificationEvent, eventDescription?: string) =>
            client.sendNotification({
                issuerMetadata,
                notification: {
                    notificationId:
                        response.credentialResponse.notification_id!,
                    event,
                    eventDescription,
                },
                accessToken: accessTokenResponse.access_token,
            });
        return { ...response, notify };
    }

    async function getClaims(offerResponse: any): Promise<Record<string, any>> {
        const credentialResponse = await retrieveCredentials(offerResponse);
        const credential = (
            credentialResponse.credentialResponse.credentials?.[0] as any
        ).credential;
        return sdjwt.getClaims(credential) as Promise<Record<string, any>>;
    }

    async function getCredentialErrorResponse(offerResponse: any) {
        const error = await retrieveCredentials(offerResponse).then(
            () => {
                throw new Error("Expected the credential request to fail");
            },
            (error: Openid4vciRetrieveCredentialsError) => error,
        );
        return error.response.credentialErrorResponseResult?.data;
    }

    function createWebhookOffer(credentialConfigurationId: string) {
        return request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                flow: "pre_authorized_code",
                response_type: "uri",
                credentialConfigurationIds: [credentialConfigurationId],
                credentialClaims: {
                    [credentialConfigurationId]: {
                        type: "webhook",
                        webhook: {
                            url: "http://localhost:8787/request",
                            auth: { type: "none" },
                        },
                    },
                },
            })
            .expect(201);
    }
});
