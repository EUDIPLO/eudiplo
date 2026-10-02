import "reflect-metadata";
import { createHash } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import * as x509Lib from "@peculiar/x509";
import { CryptoKey, generateKeyPair } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import {
    PresentationRequest,
    ResponseType,
} from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { AuthConfig } from "../../src/webhook/webhook.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    PresentationTestContext,
    prepareMdocPresentation,
    setupPresentationTestApp,
} from "../utils.js";

describe("Presentation - mDOC Credential", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let privateIssuerKey: CryptoKey;
    let issuerCert: string;
    let ctx: PresentationTestContext;
    let client: Openid4vpClient;
    let statusListService: StatusListService;

    function computeJwkThumbprint(jwks?: {
        keys?: Array<Record<string, any>>;
    }): Uint8Array | undefined {
        const keys = jwks?.keys;
        if (!keys || keys.length === 0) return undefined;

        const encJwk = keys.find((k) => k.use === "enc") ?? keys[0];
        let canonical: string | undefined;

        if (encJwk?.kty === "EC") {
            canonical = JSON.stringify({
                crv: encJwk.crv,
                kty: encJwk.kty,
                x: encJwk.x,
                y: encJwk.y,
            });
        } else if (encJwk?.kty === "OKP") {
            canonical = JSON.stringify({
                crv: encJwk.crv,
                kty: encJwk.kty,
                x: encJwk.x,
            });
        } else if (encJwk?.kty === "RSA") {
            canonical = JSON.stringify({
                e: encJwk.e,
                kty: encJwk.kty,
                n: encJwk.n,
            });
        }

        if (!canonical) return undefined;
        return new Uint8Array(
            createHash("sha256")
                .update(Buffer.from(canonical, "utf8"))
                .digest(),
        );
    }

    /**
     * Helper function to submit a mDOC presentation
     */
    async function submitMdocPresentation(values: {
        requestId: string;
        credentialId: string;
        webhookUrl?: string;
        privateKey: CryptoKey;
        issuerCert: string;
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

        const vp_token = await prepareMdocPresentation(
            resolved.authorizationRequestPayload.nonce,
            values.privateKey,
            values.issuerCert,
            resolved.authorizationRequestPayload.client_id!,
            resolved.authorizationRequestPayload.response_uri as string,
            resolved.authorizationRequestPayload.response_mode ??
                "direct_post.jwt",
            computeJwkThumbprint(
                resolved.authorizationRequestPayload.client_metadata?.jwks,
            ),
        );

        const jwt = await encryptVpToken(
            vp_token,
            values.credentialId,
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

        return { res, submitRes };
    }

    beforeAll(async () => {
        ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        privateIssuerKey = ctx.privateIssuerKey;
        issuerCert = ctx.issuerCert;
        statusListService = ctx.statusListService;

        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    test("present mso mdoc credential", async () => {
        const { submitRes } = await submitMdocPresentation({
            requestId: "pid-de",
            privateKey: privateIssuerKey,
            issuerCert,
            credentialId: "pid-mso-mdoc",
        });

        expect(submitRes).toBeDefined();
        expect(submitRes.response.status).toBe(200);
    });

    test("present mso mdoc credential with status list", async () => {
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-de",
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

        const statusPayload = await statusListService.createEntry(
            { tenantId: "root", id: "mdoc-status-e2e" } as any,
            "pid-mso-mdoc",
        );
        const statusList = statusPayload.status?.status_list;
        expect(statusList).toBeDefined();

        const vp_token = await prepareMdocPresentation(
            resolved.authorizationRequestPayload.nonce,
            privateIssuerKey,
            issuerCert,
            resolved.authorizationRequestPayload.client_id!,
            resolved.authorizationRequestPayload.response_uri as string,
            resolved.authorizationRequestPayload.response_mode ??
                "direct_post.jwt",
            computeJwkThumbprint(
                resolved.authorizationRequestPayload.client_metadata?.jwks,
            ),
            {
                statusList: {
                    idx: statusList!.idx,
                    uri: statusList!.uri,
                },
            },
        );

        const jwt = await encryptVpToken(vp_token, "pid-mso-mdoc", resolved);

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

        expect(submitRes.response.status).toBe(200);
    });

    test("present mso mdoc credential using claim_sets preference order", async () => {
        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "pid-mdoc-claim-sets",
                description: "mDOC with alternative claim sets",
                dcql_query: {
                    credentials: [
                        {
                            id: "pid-mso-mdoc",
                            format: "mso_mdoc",
                            meta: {
                                doctype_value: "eu.europa.ec.eudi.pid.1",
                            },
                            claims: [
                                {
                                    id: "given_name",
                                    path: [
                                        "eu.europa.ec.eudi.pid.1",
                                        "given_name",
                                    ],
                                },
                                {
                                    id: "family_name",
                                    path: [
                                        "eu.europa.ec.eudi.pid.1",
                                        "family_name",
                                    ],
                                },
                                {
                                    id: "first_name",
                                    path: [
                                        "eu.europa.ec.eudi.pid.1",
                                        "first_name",
                                    ],
                                },
                                {
                                    id: "last_name",
                                    path: [
                                        "eu.europa.ec.eudi.pid.1",
                                        "last_name",
                                    ],
                                },
                                {
                                    id: "postal_code",
                                    path: [
                                        "eu.europa.ec.eudi.pid.1",
                                        "postal_code",
                                    ],
                                },
                            ],
                            claim_sets: [
                                ["postal_code"],
                                ["given_name", "family_name"],
                            ],
                        },
                    ],
                },
            })
            .expect(201);

        const res = await request(app.getHttpServer())
            .post("/verifier/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: ResponseType.URI,
                requestId: "pid-mdoc-claim-sets",
            })
            .expect(201);

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        const vp_token = await prepareMdocPresentation(
            resolved.authorizationRequestPayload.nonce,
            privateIssuerKey,
            issuerCert,
            resolved.authorizationRequestPayload.client_id!,
            resolved.authorizationRequestPayload.response_uri as string,
            resolved.authorizationRequestPayload.response_mode ??
                "direct_post.jwt",
            computeJwkThumbprint(
                resolved.authorizationRequestPayload.client_metadata?.jwks,
            ),
        );

        const jwt = await encryptVpToken(vp_token, "pid-mso-mdoc", resolved);

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

        expect(submitRes.response.status).toBe(200);
    });

    test("mDOC claims are stored in the session", async () => {
        const { res } = await submitMdocPresentation({
            requestId: "pid-de",
            privateKey: privateIssuerKey,
            issuerCert,
            credentialId: "pid-mso-mdoc",
        });

        const sessionId = res.body.session;

        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const session = sessionRes.body;
        expect(session.status).toBe("completed");
        expect(session.credentials).toBeDefined();
        expect(session.credentials.length).toBeGreaterThan(0);

        // The first credential set should contain the mDOC claims
        const credentialSet = session.credentials[0];
        expect(credentialSet.values).toBeDefined();
        expect(credentialSet.values.length).toBeGreaterThan(0);

        // Verify the actual claim values from the test mDOC document
        const claims = credentialSet.values[0];
        expect(claims.first_name).toBe("First");
        expect(claims.last_name).toBe("Last");
    });

    test("should reject mDOC credential signed by untrusted issuer (not in trust list)", async () => {
        // Generate a new key pair that is NOT in the trust list
        const untrustedKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });

        // Generate a self-signed certificate for the untrusted key
        x509Lib.cryptoProvider.set(globalThis.crypto);
        const untrustedCert =
            await x509Lib.X509CertificateGenerator.createSelfSigned({
                serialNumber: "01",
                name: "C=DE, CN=Untrusted mDOC Issuer",
                notBefore: new Date(),
                notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys: {
                    privateKey: untrustedKeyPair.privateKey,
                    publicKey: untrustedKeyPair.publicKey,
                },
            });

        // Convert certificate to PEM for mDOC
        const untrustedCertPem = untrustedCert.toString("pem");

        // Create a presentation request
        const requestBody: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-de",
        };

        const res = await createPresentationRequest(
            app,
            authToken,
            requestBody,
        );

        const sessionId = res.body.session;

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: res.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        // Create mDOC credential signed with the UNTRUSTED key
        const vp_token = await prepareMdocPresentation(
            resolved.authorizationRequestPayload.nonce,
            untrustedKeyPair.privateKey,
            untrustedCertPem,
            resolved.authorizationRequestPayload.client_id!,
            resolved.authorizationRequestPayload.response_uri as string,
            resolved.authorizationRequestPayload.response_mode ??
                "direct_post.jwt",
            computeJwkThumbprint(
                resolved.authorizationRequestPayload.client_metadata?.jwks,
            ),
        );

        const jwt = await encryptVpToken(vp_token, "pid-mso-mdoc", resolved);

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: jwt,
                },
                ...callbacks,
            });

        // Submit the presentation - should fail
        const submitRes = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        // The submission should be rejected with 400 per OID4VP spec when the credential fails verification
        expect(submitRes.response.status).toBe(400);

        // Verify the session is marked as failed with a trust-chain specific error
        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        expect(sessionRes.body.status).toBe("failed");
        // mDOC failures are classified like SD-JWT VC ones: a stable code and
        // a short message, also per credential in the outcome.
        expect(sessionRes.body.failureCode).toMatch(
            /^(no_trust_chain_to_root|trust_chain_not_trusted)$/,
        );
        expect(sessionRes.body.errorReason).toMatch(/trusted (root|list)/);
        expect(sessionRes.body.outcome).toMatchObject({
            result: "failed",
            error: sessionRes.body.failureCode,
            message: sessionRes.body.errorReason,
            credentials: [
                {
                    id: "pid-mso-mdoc",
                    format: "mso_mdoc",
                    verified: false,
                    error: sessionRes.body.failureCode,
                    message: sessionRes.body.errorReason,
                },
            ],
        });
    });
});
