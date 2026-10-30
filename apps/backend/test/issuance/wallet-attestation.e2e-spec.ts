import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    clientAuthenticationClientAttestationJwt,
    Jwk,
} from "@openid4vc/oauth2";
import { Openid4vciClient } from "@openid4vc/openid4vci";
import { BitsPerStatus, StatusList } from "@owf/token-status-list";
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

    // Pass webcrypto instead of setting the global provider, which the
    // backend replaced with its KMS provider for key chain certificates.
    const cert = await X509CertificateGenerator.createSelfSigned(
        {
            serialNumber: "01",
            name: "CN=Test Wallet Provider",
            notBefore: new Date(),
            notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
            signingAlgorithm: alg,
            keys: keyPair,
        },
        globalThis.crypto,
    );

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
    revocationServiceType = "http://uri.etsi.org/19602/SvcType/EAA/Revocation",
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
                ServiceTypeIdentifier: revocationServiceType,
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
 * @param overrides Claims and header parameters that replace the defaults
 */
async function createStatusListJwt(
    signingCert: {
        certificate: X509Certificate;
        privateKey: CryptoKey;
    },
    statusListUri: string,
    statusValues: Map<number, number> = new Map(),
    bits: BitsPerStatus = 1,
    overrides: {
        payload?: Record<string, unknown>;
        header?: Record<string, unknown>;
    } = {},
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
        ...overrides.payload,
    };

    const jwt = await new SignJWT(payload)
        .setProtectedHeader({
            alg: "ES256",
            typ: "statuslist+jwt",
            x5c: [x5c],
            ...overrides.header,
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
    /** The status claim; tests of malformed claims pass any value. */
    status?: unknown;
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
    if (options.status !== undefined) {
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
        nock.enableNetConnect(/^(127\.0\.0\.1|localhost):(?!8787$)/);
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

    test("should fail when the status list host serves a different list on the next request", async () => {
        const trustListUrl = "http://localhost:8787/wallet-providers-refetch";
        const statusListUrl = "http://localhost:8787/status-list-refetch";

        const currentConfig = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const trustLists = [
            {
                url: trustListUrl,
                verifierX509Der:
                    trustListSigningCert.certificate.toString("base64"),
            },
        ];
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...currentConfig.body,
                walletAttestationRequired: true,
                walletProviderTrustLists: trustLists,
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: trustLists,
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
            revocationCert.certificate,
        );
        nock("http://localhost:8787")
            .get("/wallet-providers-refetch")
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            });

        // First request: the genuine list, signed by the revocation
        // certificate, with index 5 revoked. Any later request: a list that
        // says index 5 is valid, signed by a key the trust list does not name.
        const revokedList = await createStatusListJwt(
            revocationCert,
            statusListUrl,
            new Map([[5, 1]]),
        );
        const forgedValidList = await createStatusListJwt(
            walletProviderCert,
            statusListUrl,
        );
        nock("http://localhost:8787")
            .get("/status-list-refetch")
            .reply(200, revokedList, {
                "Content-Type": "application/statuslist+jwt",
            })
            .get("/status-list-refetch")
            .reply(200, forgedValidList, {
                "Content-Type": "application/statuslist+jwt",
            });

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

        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
            status: {
                status_list: {
                    idx: 5,
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

        await expect(
            clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                { credentialOffer, issuerMetadata },
            ),
        ).rejects.toMatchObject({
            errorResponse: {
                error_description: expect.stringContaining("Invalid/Revoked"),
            },
        });
    }, 30000);

    /**
     * Configure a trust list naming the wallet provider, serve it and the
     * given status list JWT, and request a token with a wallet attestation
     * that references index `idx` of the status list at `path`.
     */
    async function requestTokenWithStatusList(options: {
        path: string;
        statusListJwt: string;
        idx?: number;
        withRevocationCert?: boolean;
        revocationServiceType?: string;
    }) {
        const trustListPath = `/wallet-providers${options.path}`;
        const statusListUrl = `http://localhost:8787${options.path}`;
        const trustLists = [
            {
                url: `http://localhost:8787${trustListPath}`,
                verifierX509Der:
                    trustListSigningCert.certificate.toString("base64"),
            },
        ];

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
                walletProviderTrustLists: trustLists,
                authorizationServers:
                    currentConfig.body.authorizationServers.map(
                        (server: { type: string }) => ({
                            ...server,
                            ...(server.type === "built-in"
                                ? {
                                      walletAttestationRequired: true,
                                      walletProviderTrustLists: trustLists,
                                  }
                                : {}),
                        }),
                    ),
            } as IssuanceDto)
            .expect(201);

        const trustListJwt = await createMockTrustListJwt(
            trustListSigningCert,
            walletProviderCert.certificate,
            "http://uri.etsi.org/19602/SvcType/WalletSolution",
            options.withRevocationCert === false
                ? undefined
                : revocationCert.certificate,
            options.revocationServiceType,
        );
        nock("http://localhost:8787")
            .get(trustListPath)
            .reply(200, trustListJwt, {
                "Content-Type": "application/jwt",
            })
            .get(options.path)
            .reply(200, options.statusListJwt, {
                "Content-Type": "application/statuslist+jwt",
            });

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

        const clientAttestationJwt = await createWalletAttestationJwt({
            walletProviderCert: walletProviderCert.certificate,
            walletProviderKey: walletProviderCert.privateKey,
            holderPublicKey: holderPublicKeyJwk as Jwk,
            authorizationServer: authServerUrl,
            status: {
                status_list: {
                    idx: options.idx ?? 0,
                    uri: statusListUrl,
                },
            },
        });

        return new Openid4vciClient({
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
        }).retrievePreAuthorizedCodeAccessTokenFromOffer({
            credentialOffer,
            issuerMetadata,
        });
    }

    function rejectedWith(text: string) {
        return {
            errorResponse: {
                error_description: expect.stringContaining(text),
            },
        };
    }

    test("should fail when the status list host serves another list of the same provider", async () => {
        // The attestation names /status-list-sub. The host serves the
        // provider's list for /status-list-other instead, validly signed, in
        // which index 5 is valid, to hide that index 5 is revoked in its own.
        const otherList = await createStatusListJwt(
            revocationCert,
            "http://localhost:8787/status-list-other",
        );

        await expect(
            requestTokenWithStatusList({
                path: "/status-list-sub",
                statusListJwt: otherList,
                idx: 5,
            }),
        ).rejects.toMatchObject(rejectedWith("does not match"));
    }, 30000);

    test("should fail when the status list token has expired", async () => {
        const now = Math.floor(Date.now() / 1000);
        const expiredList = await createStatusListJwt(
            revocationCert,
            "http://localhost:8787/status-list-expired",
            new Map(),
            1,
            { payload: { iat: now - 7200, exp: now - 3600 } },
        );

        await expect(
            requestTokenWithStatusList({
                path: "/status-list-expired",
                statusListJwt: expiredList,
            }),
        ).rejects.toMatchObject(rejectedWith("expired"));
    }, 30000);

    test("should fail when the status list token is not typed statuslist+jwt", async () => {
        const untypedList = await createStatusListJwt(
            revocationCert,
            "http://localhost:8787/status-list-typ",
            new Map(),
            1,
            { header: { typ: "JWT" } },
        );

        await expect(
            requestTokenWithStatusList({
                path: "/status-list-typ",
                statusListJwt: untypedList,
            }),
        ).rejects.toMatchObject(rejectedWith("expected statuslist+jwt"));
    }, 30000);

    test("should fail when the index is outside the status list", async () => {
        const list = await createStatusListJwt(
            revocationCert,
            "http://localhost:8787/status-list-index",
        );

        await expect(
            requestTokenWithStatusList({
                path: "/status-list-index",
                statusListJwt: list,
                idx: 128,
            }),
        ).rejects.toMatchObject(rejectedWith("outside the list"));
    }, 30000);

    test("should succeed when the status list is signed by the WalletSolution/Revocation cert", async () => {
        const list = await createStatusListJwt(
            revocationCert,
            "http://localhost:8787/status-list-wallet-revocation",
        );

        const tokenResult = await requestTokenWithStatusList({
            path: "/status-list-wallet-revocation",
            statusListJwt: list,
            revocationServiceType:
                "http://uri.etsi.org/19602/SvcType/WalletSolution/Revocation",
        });

        expect(tokenResult.accessTokenResponse.access_token).toBeDefined();
    }, 30000);

    test("should succeed when a provider without revocation cert signs its status list with its own cert", async () => {
        const list = await createStatusListJwt(
            walletProviderCert,
            "http://localhost:8787/status-list-own-cert",
        );

        const tokenResult = await requestTokenWithStatusList({
            path: "/status-list-own-cert",
            statusListJwt: list,
            withRevocationCert: false,
        });

        expect(tokenResult.accessTokenResponse.access_token).toBeDefined();
    }, 30000);

    test("should fail when a provider without revocation cert has its status list signed by another cert", async () => {
        const unknownSigner = await generateSelfSignedCertificate();
        const list = await createStatusListJwt(
            unknownSigner,
            "http://localhost:8787/status-list-foreign-cert",
        );

        await expect(
            requestTokenWithStatusList({
                path: "/status-list-foreign-cert",
                statusListJwt: list,
                withRevocationCert: false,
            }),
        ).rejects.toMatchObject(
            rejectedWith("revocation or wallet attestation certificate"),
        );
    }, 30000);

    test("should reject a status list whose payload was swapped under the original signature", async () => {
        // The revocation cert signs a list where index 5 is revoked. An
        // attacker swaps in an all-valid payload and keeps that signature.
        const statusListUrl = "http://localhost:8787/status-list-tampered";
        const signedJwt = await createStatusListJwt(
            revocationCert,
            statusListUrl,
            new Map([[5, 1]]),
        );
        const allValidJwt = await createStatusListJwt(
            revocationCert,
            statusListUrl,
        );
        const [header, forgedPayload] = allValidJwt.split(".");
        const originalSignature = signedJwt.split(".")[2];

        await expect(
            requestTokenWithStatusList({
                path: "/status-list-tampered",
                statusListJwt: `${header}.${forgedPayload}.${originalSignature}`,
                idx: 5,
            }),
        ).rejects.toMatchObject(
            rejectedWith("Status list JWT signature verification failed"),
        );
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

    type StatusCheckModeCase = {
        name: string;
        issuerMode?: "strict" | "best_effort" | "disabled";
        serverMode?: "strict" | "best_effort" | "disabled";
        statusList: "unavailable" | "out-of-range" | "revoked" | "malformed";
        accepted: boolean;
    };

    test.each<StatusCheckModeCase>([
        {
            name: "accepts when the status list cannot be fetched and no mode is set (best_effort)",
            statusList: "unavailable",
            accepted: true,
        },
        {
            name: "rejects when the status list cannot be fetched in strict mode",
            issuerMode: "strict",
            statusList: "unavailable",
            accepted: false,
        },
        {
            name: "rejects in strict mode set on the authorization server over a best_effort issuer default",
            issuerMode: "best_effort",
            serverMode: "strict",
            statusList: "unavailable",
            accepted: false,
        },
        {
            name: "rejects an index outside the status list in best_effort mode",
            issuerMode: "best_effort",
            statusList: "out-of-range",
            accepted: false,
        },
        {
            name: "rejects a malformed status claim in best_effort mode",
            issuerMode: "best_effort",
            statusList: "malformed",
            accepted: false,
        },
        {
            name: "rejects a malformed status claim in strict mode",
            issuerMode: "strict",
            statusList: "malformed",
            accepted: false,
        },
        {
            name: "accepts a malformed status claim when the status check is disabled",
            issuerMode: "disabled",
            statusList: "malformed",
            accepted: true,
        },
        {
            name: "accepts a revoked attestation when the status check is disabled",
            issuerMode: "disabled",
            statusList: "revoked",
            accepted: true,
        },
        {
            name: "accepts a revoked attestation when the authorization server disables the check over a strict issuer default",
            issuerMode: "strict",
            serverMode: "disabled",
            statusList: "revoked",
            accepted: true,
        },
    ])(
        "status check mode: $name",
        async ({ issuerMode, serverMode, statusList, accepted }) => {
            const trustListUrl =
                "http://localhost:8787/wallet-providers-status-mode";
            const statusListUrl = "http://localhost:8787/status-list-mode";
            const trustListRef = {
                url: trustListUrl,
                verifierX509Der:
                    trustListSigningCert.certificate.toString("base64"),
            };

            // First get current config to preserve other settings
            const currentConfig = await request(app.getHttpServer())
                .get("/issuer/config")
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200);

            /** Writes the config with the given modes; undefined leaves a mode unset. */
            const saveConfig = (
                issuer: StatusCheckModeCase["issuerMode"],
                server: StatusCheckModeCase["serverMode"],
            ) =>
                request(app.getHttpServer())
                    .post("/issuer/config")
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({
                        ...currentConfig.body,
                        walletAttestationRequired: true,
                        walletProviderTrustLists: [trustListRef],
                        walletAttestationStatusCheckMode: issuer ?? null,
                        authorizationServers:
                            currentConfig.body.authorizationServers.map(
                                ({
                                    walletAttestationStatusCheckMode: _mode,
                                    ...rest
                                }: {
                                    type: string;
                                    walletAttestationStatusCheckMode?: string;
                                }) => ({
                                    ...rest,
                                    ...(rest.type === "built-in"
                                        ? {
                                              walletAttestationRequired: true,
                                              walletProviderTrustLists: [
                                                  trustListRef,
                                              ],
                                              ...(server && {
                                                  walletAttestationStatusCheckMode:
                                                      server,
                                              }),
                                          }
                                        : {}),
                                }),
                            ),
                    } as IssuanceDto)
                    .expect(201);

            await saveConfig(issuerMode, serverMode);

            try {
                const trustListJwt = await createMockTrustListJwt(
                    trustListSigningCert,
                    walletProviderCert.certificate,
                    "http://uri.etsi.org/19602/SvcType/WalletSolution",
                    revocationCert.certificate,
                );
                nock("http://localhost:8787")
                    .get("/wallet-providers-status-mode")
                    .reply(200, trustListJwt, {
                        "Content-Type": "application/jwt",
                    });

                // Index 5 is revoked; the list has 128 entries.
                // A malformed status claim names no list to fetch.
                const statusListNock =
                    statusList === "unavailable"
                        ? nock("http://localhost:8787")
                              .get("/status-list-mode")
                              .reply(500, "Service Unavailable")
                        : nock("http://localhost:8787")
                              .get("/status-list-mode")
                              .reply(
                                  200,
                                  await createStatusListJwt(
                                      revocationCert,
                                      statusListUrl,
                                      new Map([[5, 1]]),
                                  ),
                                  {
                                      "Content-Type":
                                          "application/statuslist+jwt",
                                  },
                              );

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
                const holderPrivateKeyJwk = await exportJWK(
                    holderKeyPair.privateKey,
                );
                const holderPublicKeyJwk = await exportJWK(
                    holderKeyPair.publicKey,
                );
                holderPublicKeyJwk.alg = "ES256";
                holderPublicKeyJwk.use = "sig";

                const client = new Openid4vciClient({
                    callbacks: {
                        ...callbacks,
                        clientAuthentication: clientAuthenticationAnonymous(),
                        signJwt: getSignJwtCallback([
                            holderPrivateKeyJwk as Jwk,
                        ]),
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

                const clientAttestationJwt = await createWalletAttestationJwt({
                    walletProviderCert: walletProviderCert.certificate,
                    walletProviderKey: walletProviderCert.privateKey,
                    holderPublicKey: holderPublicKeyJwk as Jwk,
                    authorizationServer: authServerUrl,
                    status: {
                        status_list:
                            statusList === "malformed"
                                ? { uri: statusListUrl }
                                : {
                                      idx:
                                          statusList === "out-of-range"
                                              ? 500
                                              : 5,
                                      uri: statusListUrl,
                                  },
                    },
                });

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

                const tokenRequest =
                    clientWithAttestation.retrievePreAuthorizedCodeAccessTokenFromOffer(
                        { credentialOffer, issuerMetadata },
                    );

                if (accepted) {
                    const tokenResult = await tokenRequest;
                    expect(
                        tokenResult.accessTokenResponse.access_token,
                    ).toBeDefined();
                } else {
                    await expect(tokenRequest).rejects.toMatchObject({
                        // Fetch failures get the generic message, lists
                        // that cannot be used name the reason.
                        errorResponse: {
                            error_description: expect.stringMatching(
                                /^Wallet attestation status (check failed$|list rejected: )/,
                            ),
                        },
                    });
                }
                // Disabled never fetches the status list, nor does a
                // malformed status claim.
                expect(statusListNock.isDone()).toBe(
                    statusList !== "malformed" &&
                        issuerMode !== "disabled" &&
                        serverMode !== "disabled",
                );
            } finally {
                // Later tests copy the current config; leave no mode behind.
                await saveConfig(undefined, undefined);
            }
        },
        30000,
    );

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
