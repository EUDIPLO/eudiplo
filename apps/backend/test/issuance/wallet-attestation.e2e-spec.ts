import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    clientAuthenticationClientAttestationJwt,
    Jwk,
} from "@openid4vc/oauth2";
import { Openid4vciClient } from "@openid4vc/openid4vci";
import { BitsPerStatus, StatusList } from "@owf/token-status-list";
import * as x509 from "@peculiar/x509";
import { X509Certificate, X509CertificateGenerator } from "@peculiar/x509";
import { exportJWK, generateKeyPair, importPKCS8, SignJWT } from "jose";
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
import { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { StatusListVerifierService } from "../../src/trust/status-list-verifier.service.js";
import { TrustStoreService } from "../../src/trust/trust-store.service.js";
import {
    callbacks,
    getSignJwtCallback,
    IssuanceTestContext,
    setupIssuanceTestApp,
} from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

/**
 * Helper to generate a self-signed certificate for testing.
 * Returns both the certificate and its private key.
 */
async function generateSelfSignedCertificate() {
    // Generate EC key pair
    const keyPair = await globalThis.crypto.subtle.generateKey(
        {
            name: "ECDSA",
            namedCurve: "P-256",
        },
        true,
        ["sign", "verify"],
    );

    const alg = {
        name: "ECDSA",
        hash: "SHA-256",
    };

    // Set up the x509 crypto provider
    x509.cryptoProvider.set(globalThis.crypto);

    const cert = await X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: "CN=Test Wallet Provider",
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        signingAlgorithm: alg,
        keys: keyPair,
    });

    return {
        certificate: cert,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
    };
}

/**
 * Creates a mock LoTE trust list JWT containing the given certificate.
 * Optionally includes a revocation certificate for status list verification.
 */
async function createMockTrustListJwt(
    signingCert: {
        certificate: X509Certificate;
        privateKey: CryptoKey;
    },
    walletProviderCert: X509Certificate,
    serviceType: string,
    revocationCert?: X509Certificate,
): Promise<string> {
    // Export the private key for jose signing
    const privateKeyArrayBuffer = await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        signingCert.privateKey,
    );
    const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\n" +
        Buffer.from(privateKeyArrayBuffer).toString("base64") +
        "\n-----END PRIVATE KEY-----";
    const signingKey = await importPKCS8(privateKeyPem, "ES256");

    const x5c = signingCert.certificate.toString("base64");
    const walletCertBase64 = walletProviderCert.toString("base64");

    // Build services list
    const services = [
        {
            ServiceInformation: {
                ServiceTypeIdentifier: serviceType,
                ServiceName: [
                    {
                        lang: "en",
                        value: "Wallet Provider Service",
                    },
                ],
                ServiceDigitalIdentity: {
                    X509Certificates: [{ val: walletCertBase64 }],
                },
            },
        },
    ];

    // Add revocation service if provided
    if (revocationCert) {
        const revocationCertBase64 = revocationCert.toString("base64");
        services.push({
            ServiceInformation: {
                ServiceTypeIdentifier:
                    "http://uri.etsi.org/19602/SvcType/EAA/Revocation",
                ServiceName: [
                    {
                        lang: "en",
                        value: "Revocation Service",
                    },
                ],
                ServiceDigitalIdentity: {
                    X509Certificates: [{ val: revocationCertBase64 }],
                },
            },
        });
    }

    const lotePayload = {
        LoTE: {
            ListAndSchemeInformation: {
                LoTEVersionIdentifier: 1,
                LoTESequenceNumber: 1,
                LoTEType:
                    "http://uri.etsi.org/19602/LoTEType/EUEAAProvidersList",
                StatusDeterminationApproach:
                    "http://uri.etsi.org/19602/EUEAAProvidersList/StatusDetn/EU",
                SchemeTerritory: "EU",
                NextUpdate: new Date(
                    Date.now() + 365 * 24 * 60 * 60 * 1000,
                ).toISOString(),
                ListIssueDateTime: new Date().toISOString(),
                SchemeOperatorName: [{ lang: "en", value: "Test Operator" }],
            },
            TrustedEntitiesList: [
                {
                    TrustedEntityInformation: {
                        TEName: [{ lang: "en", value: "Test Wallet Provider" }],
                    },
                    TrustedEntityServices: services,
                },
            ],
        },
    };

    const jwt = await new SignJWT(lotePayload)
        .setProtectedHeader({
            alg: "ES256",
            typ: "JWT",
            x5c: [x5c],
        })
        .setIssuedAt()
        .setExpirationTime("1y")
        .sign(signingKey);

    return jwt;
}

/**
 * Creates a status list JWT for testing.
 * @param signingCert The certificate and key to sign with (should be the revocation cert)
 * @param statusListUri The URI where this status list is hosted
 * @param statusValues Map of index to status value (0=valid, 1=invalid, 2=suspended)
 * @param bits Number of bits per status entry (1 for revoked only, 2 for revoked+suspended)
 */
async function createStatusListJwt(
    signingCert: {
        certificate: X509Certificate;
        privateKey: CryptoKey;
    },
    statusListUri: string,
    statusValues: Map<number, number> = new Map(),
    bits: BitsPerStatus = 1,
): Promise<string> {
    // Export the private key for jose signing
    const privateKeyArrayBuffer = await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        signingCert.privateKey,
    );
    const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\n" +
        Buffer.from(privateKeyArrayBuffer).toString("base64") +
        "\n-----END PRIVATE KEY-----";
    const signingKey = await importPKCS8(privateKeyPem, "ES256");

    const x5c = signingCert.certificate.toString("base64");

    // Create status list using the library for proper compression
    const listSize = 128; // 128 entries
    const elements = new Array(listSize).fill(0);

    // Set status values at specific indices
    for (const [index, status] of statusValues) {
        if (index < listSize) {
            elements[index] = status;
        }
    }

    const statusList = new StatusList(elements, bits);
    // Convert compressed bytes to base64 for JWT payload
    const compressedBytes = statusList.compressStatusListToBytes();
    const compressedList = Buffer.from(compressedBytes).toString("base64url");

    const payload = {
        iss: "https://wallet-provider.example.com",
        sub: statusListUri,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ttl: 300, // 5 minute TTL
        status_list: {
            bits,
            lst: compressedList,
        },
    };

    const jwt = await new SignJWT(payload)
        .setProtectedHeader({
            alg: "ES256",
            typ: "statuslist+jwt",
            x5c: [x5c],
        })
        .sign(signingKey);

    return jwt;
}

/**
 * Creates a wallet attestation JWT with x5c header.
 * Optionally includes a status claim for status list verification testing.
 */
async function createWalletAttestationJwt(options: {
    walletProviderCert: X509Certificate;
    walletProviderKey: CryptoKey;
    holderPublicKey: Jwk;
    authorizationServer: string;
    status?: {
        status_list: {
            idx: number;
            uri: string;
        };
    };
}): Promise<string> {
    // Export the private key for jose signing
    const privateKeyArrayBuffer = await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        options.walletProviderKey,
    );
    const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\n" +
        Buffer.from(privateKeyArrayBuffer).toString("base64") +
        "\n-----END PRIVATE KEY-----";
    const signingKey = await importPKCS8(privateKeyPem, "ES256");

    const x5c = options.walletProviderCert.toString("base64");

    const payload: Record<string, unknown> = {
        iss: "https://wallet-provider.example.com",
        sub: "wallet-instance-id",
        aud: [options.authorizationServer],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        cnf: {
            jwk: options.holderPublicKey,
        },
    };

    // Add status claim if provided
    if (options.status) {
        payload.status = options.status;
    }

    const jwt = await new SignJWT(payload)
        .setProtectedHeader({
            alg: "ES256",
            typ: "oauth-client-attestation+jwt",
            x5c: [x5c],
        })
        .sign(signingKey);

    return jwt;
}

/**
 * Creates a wallet attestation PoP JWT.
 */
async function _createWalletAttestationPopJwt(options: {
    holderPrivateKey: CryptoKey;
    holderPublicKey: Jwk;
    authorizationServer: string;
    nonce?: string;
}): Promise<string> {
    // Export the private key for jose signing
    const privateKeyArrayBuffer = await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        options.holderPrivateKey,
    );
    const privateKeyPem =
        "-----BEGIN PRIVATE KEY-----\n" +
        Buffer.from(privateKeyArrayBuffer).toString("base64") +
        "\n-----END PRIVATE KEY-----";
    const signingKey = await importPKCS8(privateKeyPem, "ES256");

    const payload: Record<string, unknown> = {
        iss: "wallet-instance-id",
        aud: [options.authorizationServer],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: globalThis.crypto.randomUUID(),
    };

    if (options.nonce) {
        payload.nonce = options.nonce;
    }

    const jwt = await new SignJWT(payload)
        .setProtectedHeader({
            alg: "ES256",
            typ: "wallet-attestation-pop+jwt",
            jwk: options.holderPublicKey,
        })
        .sign(signingKey);

    return jwt;
}

describe("Issuance - Wallet Attestation", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;
    let trustStoreService: TrustStoreService;
    let statusListVerifierService: StatusListVerifierService;
    let walletProviderCert: {
        certificate: X509Certificate;
        privateKey: CryptoKey;
        publicKey: CryptoKey;
    };
    let trustListSigningCert: {
        certificate: X509Certificate;
        privateKey: CryptoKey;
        publicKey: CryptoKey;
    };
    let revocationCert: {
        certificate: X509Certificate;
        privateKey: CryptoKey;
        publicKey: CryptoKey;
    };

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        // Get services for cache clearing
        trustStoreService = app.get(TrustStoreService);
        statusListVerifierService = app.get(StatusListVerifierService);

        // Generate certificates for testing
        walletProviderCert = await generateSelfSignedCertificate();
        trustListSigningCert = await generateSelfSignedCertificate();
        revocationCert = await generateSelfSignedCertificate();
    });

    beforeEach(() => {
        // Clear caches to ensure fresh state for each test
        trustStoreService.clearCache();
        statusListVerifierService.clearCache();

        // Enable nock to intercept HTTP requests
        nock.disableNetConnect();
        // Allow localhost connections for the test app itself (but not port 8787 which we mock)
        nock.enableNetConnect(/127\.0\.0\.1/);
    });

    afterEach(() => {
        nock.cleanAll();
        nock.enableNetConnect();
    });

    afterAll(async () => {
        await app?.close();
    });

    test.each(["issuer-default", "as-override"])(
        "should succeed with valid wallet attestation when required (%s)",
        async (policySource) => {
            // Configure issuance with wallet attestation required
            const trustListUrl = "http://localhost:8787/wallet-providers";

            // First get current config to preserve other settings
            const currentConfig = await request(app.getHttpServer())
                .get("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

            const walletProviderTrustLists = [
                {
                    url: trustListUrl,
                    verifierX509Der:
                        trustListSigningCert.certificate.toString("base64"),
                },
            ];
            try {
                await request(app.getHttpServer())
                    .post("/issuer/config")
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({
                        ...currentConfig.body,
                        walletAttestationRequired:
                            policySource === "issuer-default",
                        walletProviderTrustLists:
                            policySource === "issuer-default"
                                ? walletProviderTrustLists
                                : [],
                        authorizationServers:
                            currentConfig.body.authorizationServers.map(
                                (server: { type: string }) => ({
                                    ...server,
                                    ...(server.type === "built-in"
                                        ? {
                                              walletAttestationRequired: true,
                                              walletProviderTrustLists: [
                                                  {
                                                      url: trustListUrl,
                                                      verifierX509Der:
                                                          trustListSigningCert.certificate.toString(
                                                              "base64",
                                                          ),
                                                  },
                                              ],
                                          }
                                        : {}),
                                }),
                            ),
                    } as IssuanceDto)
                    .expect(201);

                // Mock the trust list endpoint using the ETSI wallet-solution issuance service type.
                const trustListJwt = await createMockTrustListJwt(
                    trustListSigningCert,
                    walletProviderCert.certificate,
                    "http://uri.etsi.org/19602/SvcType/WalletSolution/Issuance",
                );

                const nockScope = nock("http://localhost:8787")
                    .get("/wallet-providers")
                    .reply(200, trustListJwt, {
                        "Content-Type": "application/jwt",
                    });

                // Verify nock is set up correctly
                expect(nockScope.isDone()).toBe(false); // Should not be called yet

                // Create offer
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

                // Generate holder keys
                const holderKeyPair = await generateKeyPair("ES256", {
                    extractable: true,
                });
                const holderPrivateKeyJwk = await exportJWK(
                    holderKeyPair.privateKey,
                );
                const holderPublicKeyJwk = await exportJWK(
                    holderKeyPair.publicKey,
                );
                holderPublicKeyJwk.alg = "ES256";
                holderPublicKeyJwk.use = "sig";

                const credentialOffer = await new Openid4vciClient({
                    callbacks: {
                        ...callbacks,
                        clientAuthentication: clientAuthenticationAnonymous(),
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                    },
                }).resolveCredentialOffer(offerResponse.body.uri);

                const issuerMetadata = await new Openid4vciClient({
                    callbacks: {
                        ...callbacks,
                        clientAuthentication: clientAuthenticationAnonymous(),
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                    },
                }).resolveIssuerMetadata(credentialOffer.credential_issuer);

                // Get authorization server URL for attestation
                const authServerUrl =
                    issuerMetadata.authorizationServers?.[0]?.issuer ||
                    credentialOffer.credential_issuer;

                // Create wallet attestation
                const clientAttestationJwt = await createWalletAttestationJwt({
                    walletProviderCert: walletProviderCert.certificate,
                    walletProviderKey: walletProviderCert.privateKey,
                    holderPublicKey: holderPublicKeyJwk as Jwk,
                    authorizationServer: authServerUrl,
                });

                // Create a client with attestation-based authentication
                const clientWithAttestation = new Openid4vciClient({
                    callbacks: {
                        ...callbacks,
                        clientAuthentication:
                            clientAuthenticationClientAttestationJwt({
                                clientAttestationJwt,
                                callbacks: {
                                    signJwt: getSignJwtCallback([
                                        holderPrivateKeyJwk as Jwk,
                                    ]),
                                    generateRandom: callbacks.generateRandom,
                                },
                            }),
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                    },
                });

                // Try to get access token with wallet attestation
                const tokenResult =
                    await clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                        {
                            credentialOffer,
                            issuerMetadata,
                        },
                    );

                expect(
                    tokenResult.accessTokenResponse.access_token,
                ).toBeDefined();

                // Verify nock was called
                expect(nockScope.isDone()).toBe(true);
            } finally {
                await request(app.getHttpServer())
                    .post("/issuer/config")
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send(currentConfig.body)
                    .expect(201);
            }
        },
        30000,
    );

    test("should fail when wallet attestation is required but not provided", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://trust-list.example.com/wallet-providers";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);

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

        const preAuthorizedGrant =
            credentialOffer.grants?.[
                "urn:ietf:params:oauth:grant-type:pre-authorized_code"
            ];
        if (!preAuthorizedGrant) {
            throw new Error(
                "Credential offer does not contain a pre-authorized code grant",
            );
        }

        const authorizationServerIssuer =
            issuerMetadata.authorizationServers?.[0]?.issuer ??
            credentialOffer.credential_issuer;
        await request(app.getHttpServer())
            .post(
                new URL("authorize/token", `${authorizationServerIssuer}/`)
                    .pathname,
            )
            .trustLocalhost()
            .type("form")
            .send({
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                "pre-authorized_code":
                    preAuthorizedGrant["pre-authorized_code"],
            })
            .expect(401);
    });

    test("should fail when wallet provider is not in trust list", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl =
            "http://trust-list.example.com/wallet-providers-empty";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Generate a DIFFERENT wallet provider certificate (not in trust list)
        const untrustedWalletCert = await generateSelfSignedCertificate();

        // Mock the trust list endpoint with the ORIGINAL wallet provider cert
        // so the new untrusted cert won't match
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate, // Original trusted cert
            "http://uri.etsi.org/19602/SvcType/EAA/WalletProvider",
        );

        nock("http://trust-list.example.com")
            .get("/wallet-providers-empty")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServer =
            issuerMetadata.authorizationServers?.[0].issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation with UNTRUSTED certificate
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: untrustedWalletCert.certificate,
            walletProviderKey: untrustedWalletCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServer,
        });

        // Create client with attestation-based authentication using UNTRUSTED cert
        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Try to get access token - should fail because cert is not in trust list
        await expect(
            clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            ),
        ).rejects.toThrow();
    });

    test("should succeed when wallet attestation is not required", async () => {
        // Clean up any pending nock mocks
        nock.cleanAll();

        // Configure issuance WITHOUT wallet attestation required
        // First get current config to preserve other settings
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
                walletAttestationRequired: false,
                walletProviderTrustLists: [],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: false,
                                      walletProviderTrustLists: [],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const _holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);

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

        // Get access token WITHOUT wallet attestation - should succeed
        const tokenResult =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });

        expect(tokenResult.accessTokenResponse.access_token).toBeDefined();
    });

    test("should succeed with valid status when status list is signed by revocation cert", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://localhost:8787/wallet-providers-status";
        const statusListUrl = "http://localhost:8787/status-list";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint with revocation cert
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
            revocationCert.certificate,
        );

        nock("http://localhost:8787")
            .get("/wallet-providers-status")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Mock the status list endpoint - signed by revocation cert
        // Status at index 0 is valid (0)
        const statusListJwt = await createStatusListJwt(
            revocationCert,
            statusListUrl,
            new Map(), // Empty = all valid
        );

        nock("http://localhost:8787")
            .get("/status-list")
            .times(2) // Called twice: once for signature verification, once for status check
            .reply(200, statusListJwt, {
                "Content-Type": "application/statuslist+jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

        const credentialOffer = await new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        }).resolveCredentialOffer(offerResponse.body.uri);

        const issuerMetadata = await new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        }).resolveIssuerMetadata(credentialOffer.credential_issuer);

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation with status claim
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
            status: {
                status_list: {
                    idx: 0,
                    uri: statusListUrl,
                },
            },
        });

        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should succeed - status is valid and signed by correct revocation cert
        const tokenResult =
            await clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            );

        expect(tokenResult.accessTokenResponse.access_token).toBeDefined();
    }, 30000);

    test("should fail when status list is signed by wrong certificate", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl =
            "http://localhost:8787/wallet-providers-wrong-signer";
        const statusListUrl = "http://localhost:8787/status-list-wrong-signer";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint with revocation cert
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
            revocationCert.certificate,
        );

        nock("http://localhost:8787")
            .get("/wallet-providers-wrong-signer")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Generate a DIFFERENT certificate to sign the status list (wrong signer)
        const wrongSignerCert = await generateSelfSignedCertificate();

        // Mock the status list endpoint - signed by WRONG cert (not the revocation cert)
        const statusListJwt = await createStatusListJwt(
            wrongSignerCert,
            statusListUrl,
            new Map(), // All valid
        );

        nock("http://localhost:8787")
            .get("/status-list-wrong-signer")
            .reply(200, statusListJwt, {
                "Content-Type": "application/statuslist+jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation with status claim
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
            status: {
                status_list: {
                    idx: 0,
                    uri: statusListUrl,
                },
            },
        });

        // Create client with attestation-based authentication
        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should fail - status list is signed by wrong certificate
        await expect(
            clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            ),
        ).rejects.toThrow();
    }, 30000);

    test("should fail when wallet attestation status indicates revoked", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://localhost:8787/wallet-providers-revoked";
        const statusListUrl = "http://localhost:8787/status-list-revoked";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint with revocation cert
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
            revocationCert.certificate,
        );

        const trustListNock = nock("http://localhost:8787")
            .get("/wallet-providers-revoked")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Mock the status list endpoint - index 5 is REVOKED (status = 1)
        const statusListJwt = await createStatusListJwt(
            revocationCert,
            statusListUrl,
            new Map([[5, 1]]), // Index 5 is revoked
        );

        const statusListNock = nock("http://localhost:8787")
            .get("/status-list-revoked")
            .times(2) // Called twice: once for signature verification, once for status check
            .reply(200, statusListJwt, {
                "Content-Type": "application/statuslist+jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation with status claim pointing to REVOKED index
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
            status: {
                status_list: {
                    idx: 5, // This index is revoked
                    uri: statusListUrl,
                },
            },
        });

        // Create client with attestation-based authentication
        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should fail - attestation status is revoked
        try {
            await clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            );
            throw new Error("Expected request to fail with revoked status");
        } catch (err: any) {
            // Verify the error is about the revoked status
            if (
                err.message === "Expected request to fail with revoked status"
            ) {
                throw err;
            }
            // Check if nock was called
            expect(trustListNock.isDone()).toBe(true);
            expect(statusListNock.isDone()).toBe(true);
        }
    }, 30000);

    test("should fail when wallet attestation status indicates suspended", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://localhost:8787/wallet-providers-suspended";
        const statusListUrl = "http://localhost:8787/status-list-suspended";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint with revocation cert
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
            revocationCert.certificate,
        );

        nock("http://localhost:8787")
            .get("/wallet-providers-suspended")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Mock the status list endpoint - index 3 is SUSPENDED (status = 2)
        // Need 2 bits per entry to support suspended status
        const statusListJwt = await createStatusListJwt(
            revocationCert,
            statusListUrl,
            new Map([[3, 2]]), // Index 3 is suspended
            2, // 2 bits per entry to support status values 0-3
        );

        nock("http://localhost:8787")
            .get("/status-list-suspended")
            .times(2) // Called twice: once for signature verification, once for status check
            .reply(200, statusListJwt, {
                "Content-Type": "application/statuslist+jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation with status claim pointing to SUSPENDED index
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
            status: {
                status_list: {
                    idx: 3, // This index is suspended
                    uri: statusListUrl,
                },
            },
        });

        // Create client with attestation-based authentication
        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should fail - attestation status is suspended
        await expect(
            clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            ),
        ).rejects.toThrow();
    }, 30000);

    test("should fail when trust list fetch fails", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://localhost:8787/trust-list-error";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint to return an error
        nock("http://localhost:8787")
            .get("/trust-list-error")
            .reply(500, "Internal Server Error");

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
        });

        // Create client with attestation-based authentication
        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should fail - trust list fetch fails
        await expect(
            clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            ),
        ).rejects.toThrow();
    });

    test("should fail when trust list returns invalid JWT", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://localhost:8787/trust-list-invalid";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint to return invalid JWT
        nock("http://localhost:8787")
            .get("/trust-list-invalid")
            .reply(200, "not-a-valid-jwt", {
                "Content-Type": "application/jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
        });

        // Create client with attestation-based authentication
        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should fail - trust list is not valid JWT
        await expect(
            clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            ),
        ).rejects.toThrow();
    });

    test("should fail when wallet attestation is signed by different key than in x5c", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://localhost:8787/wallet-providers-sig-fail";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
        );

        nock("http://localhost:8787")
            .get("/wallet-providers-sig-fail")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create a wallet attestation signed with DIFFERENT key than the one in x5c
        // Generate a different key to sign with
        const differentSigningCert = await generateSelfSignedCertificate();

        // Manually create a malformed JWT: sign with different key but use original cert in x5c
        const privateKeyArrayBuffer = await globalThis.crypto.subtle.exportKey(
            "pkcs8",
            differentSigningCert.privateKey, // Different key!
        );
        const privateKeyPem =
            "-----BEGIN PRIVATE KEY-----\n" +
            Buffer.from(privateKeyArrayBuffer).toString("base64") +
            "\n-----END PRIVATE KEY-----";
        const signingKey = await importPKCS8(privateKeyPem, "ES256");

        // Use original cert in x5c (mismatch)
        const x5c = walletProviderCert.certificate.toString("base64");

        const payload: Record<string, unknown> = {
            iss: "https://wallet-provider.example.com",
            sub: "wallet-instance-id",
            aud: [authServerUrl],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
            cnf: {
                jwk: holderPublicKeyJwk,
            },
        };

        const malformedAttestationJwt = await new SignJWT(payload)
            .setProtectedHeader({
                alg: "ES256",
                typ: "oauth-client-attestation+jwt",
                x5c: [x5c], // Original cert but signed with different key
            })
            .sign(signingKey);

        // Create client with attestation-based authentication using malformed JWT
        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt: malformedAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should fail - signature doesn't match x5c
        await expect(
            clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            ),
        ).rejects.toThrow();
    });

    test("should succeed but log warning when status list fetch fails", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl =
            "http://localhost:8787/wallet-providers-status-fail";
        const statusListUrl = "http://localhost:8787/status-list-fail";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: [
                                          {
                                              url: trustListUrl,
                                              verifierX509Der:
                                                  trustListSigningCert.certificate.toString(
                                                      "base64",
                                                  ),
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint with revocation cert
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
            revocationCert.certificate,
        );

        nock("http://localhost:8787")
            .get("/wallet-providers-status-fail")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Mock the status list endpoint to fail (network error)
        nock("http://localhost:8787")
            .get("/status-list-fail")
            .reply(500, "Service Unavailable");

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

        const credentialOffer = await new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        }).resolveCredentialOffer(offerResponse.body.uri);

        const issuerMetadata = await new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        }).resolveIssuerMetadata(credentialOffer.credential_issuer);

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation with status claim pointing to failing URL
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
            status: {
                status_list: {
                    idx: 0,
                    uri: statusListUrl,
                },
            },
        });

        const clientWithAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should succeed - status list fetch failure is not a hard failure per spec
        // The service logs a warning but doesn't block the request
        const tokenResult =
            await clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            );

        expect(tokenResult.accessTokenResponse.access_token).toBeDefined();
    }, 30000);

    test("should fail when wallet attestation PoP JWT has wrong audience", async () => {
        // Configure issuance with wallet attestation required
        const trustListUrl = "http://localhost:8787/wallet-providers-wrong-aud";

        // First get current config to preserve other settings
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
                walletAttestationRequired: true,
                walletProviderTrustLists: [
                    {
                        url: trustListUrl,
                        verifierX509Der:
                            trustListSigningCert.certificate.toString("base64"),
                    },
                ],
            } as IssuanceDto)
            .expect(201);

        // Mock the trust list endpoint
        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
        );

        nock("http://localhost:8787")
            .get("/wallet-providers-wrong-aud")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // Create offer
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

        // Generate holder keys
        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);
        holderPublicKeyJwk.alg = "ES256";
        holderPublicKeyJwk.use = "sig";

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

        const authServerUrl =
            issuerMetadata.authorizationServers?.[0]?.issuer ||
            credentialOffer.credential_issuer;

        // Create wallet attestation with correct audience
        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
        });

        // Create client with attestation that will generate PoP with WRONG audience
        // We need a custom signJwt that generates PoP with wrong audience
        const clientWithWrongAudAttestation = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationClientAttestationJwt({
                    clientAttestationJwt,
                    callbacks: {
                        signJwt: async (jwtSigner, jwt) => {
                            // Override the audience in the PoP JWT
                            const modifiedJwt = {
                                ...jwt,
                                payload: {
                                    ...jwt.payload,
                                    aud: ["https://wrong-audience.example.com"],
                                },
                            };
                            return getSignJwtCallback([
                                holderPrivateKeyJwk as Jwk,
                            ])(jwtSigner, modifiedJwt);
                        },
                        generateRandom: callbacks.generateRandom,
                    },
                }),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });

        // Should fail - PoP JWT audience doesn't match
        await expect(
            clientWithWrongAudAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                {
                    credentialOffer,
                    issuerMetadata,
                },
            ),
        ).rejects.toThrow();
    });
});
