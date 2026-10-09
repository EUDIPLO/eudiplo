import crypto from "node:crypto";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { digest, ES256 } from "@owf/crypto";
import { kbPayload } from "@sd-jwt/core";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { base64url, CryptoKey } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import {
    PresentationRequest,
    ResponseType,
} from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { PresentationConfigCreateDto } from "../../src/verifier/presentations/dto/presentation-config-create.dto.js";
import { TransactionData } from "../../src/verifier/presentations/entities/presentation-config.entity.js";
import { AuthConfig } from "../../src/webhook/webhook.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    PresentationTestContext,
    setupPresentationTestApp,
} from "../utils.js";

/**
 * Creates a credential for testing (similar to the internal createCredential in utils.ts)
 */
async function createCredentialWithStatus(options: {
    claims: any;
    privateKey: CryptoKey;
    x5c: string[];
}) {
    const { privateKeyHolder, publicKeyHolder } =
        await ES256.generateKeyPair().then((keyPair) => ({
            privateKeyHolder: keyPair.privateKey,
            publicKeyHolder: keyPair.publicKey,
        }));

    const sdjwt = new SDJwtVcInstance({
        signer: async (data: string) => {
            const encoder = new TextEncoder();
            const signature = await globalThis.crypto.subtle.sign(
                { name: "ECDSA", hash: "SHA-256" },
                options.privateKey,
                encoder.encode(data),
            );

            return btoa(String.fromCodePoint(...new Uint8Array(signature)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replace(/=+$/, "");
        },
        signAlg: "ES256",
        hasher: digest,
        loadTypeMetadataFormat: true,
        saltGenerator: (length: number) =>
            crypto.randomBytes(length).toString("base64url"),
    });

    return sdjwt
        .issue(
            {
                ...options.claims,
                cnf: { jwk: publicKeyHolder },
            },
            undefined,
            {
                header: {
                    x5c: options.x5c,
                },
            },
        )
        .then((credential) => ({
            credential,
            privateKey: privateKeyHolder,
        }));
}

/**
 * Computes SHA-256 hash and returns base64url-encoded result
 * According to spec, hashes are computed over the raw string (no decoding before hashing)
 */
function computeTransactionDataHash(transactionDataBase64url: string): string {
    return base64url.encode(
        crypto.createHash("sha256").update(transactionDataBase64url).digest(),
    );
}

/**
 * Prepares a presentation with transaction_data_hashes in the KB-JWT
 */
async function preparePresentationWithTransactionData(
    kb: Omit<kbPayload, "sd_hash"> & {
        transaction_data_hashes?: string[];
        transaction_data_hashes_alg?: string;
    },
    privateKey: CryptoKey,
    x5c: string[],
    statusListService: StatusListService,
    credentialConfigId: string,
) {
    const status = await statusListService.createEntry(
        { tenantId: "root", id: "1" } as any,
        credentialConfigId,
    );

    const credential = await createCredentialWithStatus({
        claims: {
            vct: "http://localhost:3000/issuers/demo/credentials-metadata/vct/pid",
            ...status,
            birthdate: "1990-01-01",
            address: {
                locality: "Berlin",
                country: "DE",
            },
        },
        privateKey,
        x5c,
    });

    const sdjwt = new SDJwtVcInstance({
        hasher: digest,
        kbSigner: await ES256.getSigner(credential.privateKey),
        kbSignAlg: "ES256",
    });

    const presentation = await sdjwt.present(
        credential.credential,
        {
            birthdate: true,
            address: {
                locality: true,
            },
        },
        {
            kb: {
                payload: kb,
            },
        },
    );
    return presentation;
}

describe("Presentation - Transaction Data", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let privateIssuerKey: CryptoKey;
    let issuerCertChain: string[];
    let statusListService: StatusListService;
    let ctx: PresentationTestContext;

    const credentialConfigId = "pid";

    let client: Openid4vpClient;

    /**
     * Helper function to submit a presentation with transaction data support
     */
    async function submitPresentationWithTransactionData(values: {
        requestId: string;
        credentialId: string;
        webhookUrl?: string;
        privateKey: CryptoKey;
        x5c: string[];
        transactionData?: TransactionData[];
        // Transaction data hashes to include in KB-JWT (if different from computed hashes)
        overrideTransactionDataHashes?: string[];
    }) {
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: values.requestId,
            ...(values.webhookUrl && {
                webhook: {
                    url: values.webhookUrl,
                    auth: { type: AuthConfig.NONE },
                },
            }),
            ...(values.transactionData && {
                transaction_data: values.transactionData,
            }),
        };

        const res = await createPresentationRequest(
            app,
            authToken,
            requestBody,
        );

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        const x5c = values.x5c;

        // Compute transaction_data_hashes for KB-JWT if transaction data is provided
        let transactionDataHashes: string[] | undefined;
        if (values.transactionData && values.transactionData.length > 0) {
            // Filter transaction data that references this credential
            const relevantTransactionData = values.transactionData.filter(
                (td) => td.credential_ids.includes(values.credentialId),
            );
            if (relevantTransactionData.length > 0) {
                if (values.overrideTransactionDataHashes) {
                    transactionDataHashes =
                        values.overrideTransactionDataHashes;
                } else {
                    // Compute hashes as the wallet would: base64url encode each transaction data object
                    // then hash it with SHA-256 and base64url encode the result
                    transactionDataHashes = relevantTransactionData.map(
                        (td) => {
                            const encoded = base64url.encode(
                                JSON.stringify(td),
                            );
                            return computeTransactionDataHash(encoded);
                        },
                    );
                }
            }
        }

        const vp_token = await preparePresentationWithTransactionData(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
                ...(transactionDataHashes && {
                    transaction_data_hashes: transactionDataHashes,
                }),
            },
            values.privateKey,
            x5c,
            statusListService,
            credentialConfigId,
        );

        const jwt = await encryptVpToken(
            vp_token,
            values.credentialId || "pid",
            resolved,
        );

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: jwt,
                },
                ...callbacks,
            });

        const submitRes = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        return { res, submitRes, authRequest, resolved };
    }

    beforeAll(async () => {
        ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        privateIssuerKey = ctx.privateIssuerKey;
        issuerCertChain = ctx.issuerCertChain;
        statusListService = ctx.statusListService;

        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });

        // Create a presentation config with transaction data
        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "pid-with-transaction-data",
                description: "PID presentation with transaction data",
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: {
                                vct_values: [
                                    `${host}/issuers/demo/credentials-metadata/vct/pid`,
                                ],
                            },
                            claims: [
                                {
                                    path: ["address", "locality"],
                                },
                            ],
                            // No trusted_authorities: these tests exercise
                            // transaction data, not trust-list validation. The
                            // previous value referenced a trust list that was
                            // never created, so it only ever "passed" because
                            // trust validation used to fail open on load errors
                            // (fixed in credential-chain-validation.service.ts).
                        },
                    ],
                },
                transaction_data: [
                    {
                        type: "payment_authorization",
                        credential_ids: ["pid"],
                        amount: "100.00",
                        currency: "EUR",
                        merchant: "Test Merchant",
                    },
                ],
            } satisfies PresentationConfigCreateDto)
            .expect(201);
    });

    afterAll(async () => {
        await app?.close();
    });

    test("should reject presentation config with invalid dcql credentials id", async () => {
        const res = await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "pid-invalid-credential-id",
                description: "PID presentation with invalid DCQL credential id",
                dcql_query: {
                    credentials: [
                        {
                            id: "some.identifier",
                            format: "dc+sd-jwt",
                            meta: {
                                vct_values: [
                                    `${host}/issuers/demo/credentials-metadata/vct/pid`,
                                ],
                            },
                            claims: [
                                {
                                    path: ["address", "locality"],
                                },
                            ],
                        },
                    ],
                },
            } satisfies PresentationConfigCreateDto)
            .expect(400);

        expect(res.body.message).toBe("Validation failed");
    });

    test("should accept presentation with valid transaction data hashes", async () => {
        const transactionData: TransactionData[] = [
            {
                type: "payment_authorization",
                credential_ids: ["pid"],
                amount: "50.00",
                currency: "EUR",
                merchant: "E-Commerce Store",
            },
        ];

        const { submitRes } = await submitPresentationWithTransactionData({
            requestId: "pid-no-hook",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
            transactionData,
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
    });

    test("should accept presentation using transaction data from config", async () => {
        // This test uses the presentation config that already has transaction_data defined
        const { submitRes } = await submitPresentationWithTransactionData({
            requestId: "pid-with-transaction-data",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
            // Transaction data comes from the config, so we need to match what's in the config
            transactionData: [
                {
                    type: "payment_authorization",
                    credential_ids: ["pid"],
                    amount: "100.00",
                    currency: "EUR",
                    merchant: "Test Merchant",
                },
            ],
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
    });

    test("should accept presentation with multiple transaction data entries", async () => {
        const transactionData: TransactionData[] = [
            {
                type: "payment_authorization",
                credential_ids: ["pid"],
                amount: "75.00",
                currency: "EUR",
                merchant: "Store A",
            },
            {
                type: "consent",
                credential_ids: ["pid"],
                purpose: "data_sharing",
                recipient: "Partner B",
            },
        ];

        const { submitRes } = await submitPresentationWithTransactionData({
            requestId: "pid-no-hook",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
            transactionData,
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
    });

    test("should reject presentation with mismatched transaction data hashes", async () => {
        const transactionData: TransactionData[] = [
            {
                type: "payment_authorization",
                credential_ids: ["pid"],
                amount: "99.00",
                currency: "EUR",
                merchant: "Legit Store",
            },
        ];

        // Provide wrong hashes that don't match the actual transaction data
        const { res, submitRes } = await submitPresentationWithTransactionData({
            requestId: "pid-no-hook",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
            transactionData,
            overrideTransactionDataHashes: ["INVALID_HASH_THAT_WONT_MATCH"],
        });

        // Per OID4VP spec, the verifier MUST return 400
        expect(submitRes.response.status).toBe(400);

        // Verify the session is marked as failed with error reason
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${res.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.status).toBe("failed");
        expect(sessionRes.body.errorReason).toBeDefined();
    });

    test("should reject presentation when transaction data provided but no hashes in KB-JWT", async () => {
        // This simulates a wallet that doesn't include transaction_data_hashes
        // when they were expected
        const transactionData: TransactionData[] = [
            {
                type: "payment_authorization",
                credential_ids: ["pid"],
                amount: "25.00",
                currency: "EUR",
                merchant: "Quick Shop",
            },
        ];

        // Override with empty array to simulate missing hashes
        const { res, submitRes } = await submitPresentationWithTransactionData({
            requestId: "pid-no-hook",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
            transactionData,
            overrideTransactionDataHashes: [], // Empty hashes when data was expected
        });

        // Per OID4VP spec, the verifier MUST return 400
        expect(submitRes.response.status).toBe(400);

        // Verify the session is marked as failed with error reason
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${res.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.status).toBe("failed");
        expect(sessionRes.body.errorReason).toBeDefined();
    });

    test("should accept presentation without transaction data", async () => {
        // Normal presentation without any transaction data
        const { submitRes } = await submitPresentationWithTransactionData({
            requestId: "pid-no-hook",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
            // No transactionData
        });
        console.log(await submitRes.response.json());

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
    });

    test("should override config transaction data with request transaction data", async () => {
        // Use the config that has transaction data, but override it in the request
        const overrideTransactionData: TransactionData[] = [
            {
                type: "custom_authorization",
                credential_ids: ["pid"],
                custom_field: "custom_value",
            },
        ];

        const { submitRes } = await submitPresentationWithTransactionData({
            requestId: "pid-with-transaction-data",
            credentialId: "pid",
            privateKey: privateIssuerKey,
            x5c: issuerCertChain,
            transactionData: overrideTransactionData,
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
    });

    test("should persist and retrieve dynamic transaction data (Data Integrity Check)", async () => {
        const res = await request(app.getHttpServer())
            .get("/verifier/config/pid-with-transaction-data")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const transactionData = res.body.transaction_data[0];

        expect(transactionData.amount).toBe("100.00");
        expect(transactionData.currency).toBe("EUR");
        expect(transactionData.merchant).toBe("Test Merchant");
    });
});
