import "reflect-metadata";
import { readFileSync } from "node:fs";
import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    Jwk,
    JwtSignerJwk,
} from "@openid4vc/oauth2";
import {
    createKeyAttestationJwt,
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
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { buildClaims } from "../../src/issuer/configuration/credentials/utils/derive.js";
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

async function resolveCredentialOffer(offerUri: string): Promise<any> {
    const client = new Openid4vciClient({
        callbacks: {
            ...callbacks,
            clientAuthentication: clientAuthenticationAnonymous(),
        },
    });

    return client.resolveCredentialOffer(offerUri);
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

        return client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            issuerMetadata,
            proofs: {
                jwt: [proofJwt],
            },
        });
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
