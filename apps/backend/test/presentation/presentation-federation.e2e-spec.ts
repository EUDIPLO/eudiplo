import "reflect-metadata";
import { deflateSync } from "node:zlib";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import * as x509Lib from "@peculiar/x509";
import { generateKeyPair, SignJWT } from "jose";
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
import { FederationTrustService } from "../../src/trust/federation-trust.service.js";
import {
    PresentationRequest,
    ResponseType,
} from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    federationKey,
    serveFederation,
} from "../federation/federation-fixture.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    PresentationTestContext,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Presentation - OpenID Federation", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let statusListService: PresentationTestContext["statusListService"];
    let ctx: PresentationTestContext;

    let client: Openid4vpClient;

    beforeAll(async () => {
        ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = ctx.host;
        statusListService = ctx.statusListService;

        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });

        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "pid-fed-only",
                description: "PID with OpenID Federation trusted authority",
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
                            claims: [{ path: ["address", "locality"] }],
                            trusted_authorities: [
                                {
                                    type: "openid_federation",
                                    values: ["https://ta-fed.example.org"],
                                },
                            ],
                        },
                    ],
                },
            })
            .expect(201);
    });

    beforeEach(() => {
        nock.disableNetConnect();
        nock.enableNetConnect(/127\.0\.0\.1|localhost/);
    });

    afterEach(() => {
        nock.cleanAll();
        nock.enableNetConnect();
    });

    afterAll(async () => {
        await app?.close();
    });

    const TRUST_ANCHOR = "https://ta-fed.example.org";
    const ISSUER = "https://issuer-fed.example.org";

    /**
     * Present a PID with `iss` and `kid` of a federation issuer, signed with
     * `signingKey`, and return the resulting session status.
     */
    async function presentFederationCredential(
        signingKey: CryptoKey,
        header: Record<string, unknown>,
        claims: Record<string, unknown> = {},
    ): Promise<{ status: string; failureCode?: string; errorReason?: string }> {
        const presentationReq: PresentationRequest = {
            response_type: ResponseType.URI,
            requestId: "pid-fed-only",
        };

        const createRes = await createPresentationRequest(
            app,
            authToken,
            presentationReq,
        );

        const sessionId = createRes.body.session;

        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: createRes.body.uri,
        });

        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });

        const vpToken = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: resolved.authorizationRequestPayload.client_id as string,
                nonce: resolved.authorizationRequestPayload.nonce,
            },
            signingKey,
            [],
            statusListService,
            "pid",
            "1",
            "ES256",
            { header, claims: { iss: ISSUER, ...claims }, withStatus: false },
        );

        const encryptedVp = await encryptVpToken(vpToken, "pid", resolved);

        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: {
                    response: encryptedVp,
                },
                ...callbacks,
            });

        await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        const sessionRes = await request(app.getHttpServer())
            .get(`/session/${sessionId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        return {
            status: sessionRes.body.status,
            failureCode: sessionRes.body.failureCode ?? undefined,
            errorReason: sessionRes.body.errorReason ?? undefined,
        };
    }

    const credentialKey = federationKey;

    /** The credential issuer metadata listing the credential signing key. */
    const issuerMetadata = (jwk: object) => ({
        openid_credential_issuer: {
            credential_issuer: ISSUER,
            jwks: { keys: [jwk] },
        },
    });

    beforeEach(() => {
        // The verifier caches federation resolutions
        ctx.app.get(FederationTrustService).clearTrustCache();
    });

    test("accepts an SD-JWT signed with a key of its issuer's trusted federation metadata", async () => {
        const key = await credentialKey("credential-1");
        await serveFederation({
            entity: ISSUER,
            trustAnchor: TRUST_ANCHOR,
            metadata: issuerMetadata(key.jwk),
        });

        await expect(
            presentFederationCredential(key.privateKey, {
                kid: "credential-1",
            }),
        ).resolves.toMatchObject({ status: "completed" });
    });

    /** Serves a status list in which index 0 is valid, signed with `key`. */
    async function serveStatusList(
        uri: string,
        key: { privateKey: CryptoKey; jwk: { kid?: string } },
    ) {
        const lst = deflateSync(Buffer.from([0])).toString("base64url");
        const jwt = await new SignJWT({
            sub: uri,
            status_list: { bits: 1, lst },
        })
            .setProtectedHeader({
                alg: "ES256",
                typ: "statuslist+jwt",
                kid: key.jwk.kid,
            })
            .setIssuedAt()
            .sign(key.privateKey);
        const url = new URL(uri);
        nock(url.origin)
            .get(url.pathname)
            .reply(200, jwt, { "content-type": "application/statuslist+jwt" });
    }

    test("checks the status list with a key of the same issuer entity", async () => {
        const key = await credentialKey("credential-1");
        const statusKey = await credentialKey("status-1");
        await serveFederation({
            entity: ISSUER,
            trustAnchor: TRUST_ANCHOR,
            metadata: {
                openid_credential_issuer: {
                    credential_issuer: ISSUER,
                    jwks: { keys: [key.jwk, statusKey.jwk] },
                },
            },
        });
        const uri = `${ISSUER}/status/1`;
        await serveStatusList(uri, statusKey);

        await expect(
            presentFederationCredential(
                key.privateKey,
                { kid: "credential-1" },
                { status: { status_list: { idx: 0, uri } } },
            ),
        ).resolves.toMatchObject({ status: "completed" });
    });

    test("rejects a status list signed with a key its issuer does not list", async () => {
        const key = await credentialKey("credential-1");
        await serveFederation({
            entity: ISSUER,
            trustAnchor: TRUST_ANCHOR,
            metadata: issuerMetadata(key.jwk),
        });
        const uri = `${ISSUER}/status/2`;
        await serveStatusList(uri, await credentialKey("other-entity"));

        await expect(
            presentFederationCredential(
                key.privateKey,
                { kid: "credential-1" },
                { status: { status_list: { idx: 0, uri } } },
            ),
        ).resolves.toMatchObject({
            status: "failed",
            errorReason: expect.stringMatching(/status/i),
        });
    });

    test("rejects an SD-JWT whose kid is not in its issuer's metadata", async () => {
        const key = await credentialKey("credential-1");
        await serveFederation({
            entity: ISSUER,
            trustAnchor: TRUST_ANCHOR,
            metadata: issuerMetadata(key.jwk),
        });

        await expect(
            presentFederationCredential(key.privateKey, { kid: "unknown" }),
        ).resolves.toMatchObject({
            status: "failed",
            failureCode: "no_trust_chain_to_root",
        });
    });

    test("rejects a certificate that names a federation member but is signed with another key", async () => {
        // The attacker's certificate names the honest issuer entity; only the
        // key in the issuer's federation metadata is trusted.
        const member = await credentialKey("credential-1");
        const attacker = await credentialKey("credential-1");
        await serveFederation({
            entity: ISSUER,
            trustAnchor: TRUST_ANCHOR,
            metadata: issuerMetadata(member.jwk),
        });
        x509Lib.cryptoProvider.set(globalThis.crypto);
        const keys = await generateKeyPair("ES256", { extractable: true });
        const certificate =
            await x509Lib.X509CertificateGenerator.createSelfSigned({
                serialNumber: "01",
                name: `C=DE, CN=${ISSUER}`,
                notBefore: new Date(),
                notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys: keys as CryptoKeyPair,
                extensions: [
                    new x509Lib.SubjectAlternativeNameExtension([
                        { type: "url", value: ISSUER },
                    ]),
                ],
            });

        await expect(
            presentFederationCredential(attacker.privateKey, {
                kid: "credential-1",
                x5c: [certificate.toString("base64")],
            }),
        ).resolves.toMatchObject({
            status: "failed",
            failureCode: "signature_invalid",
        });
    });

    test("rejects an SD-JWT whose issuer names the trust anchor but is not its subordinate", async () => {
        // Matching an authority_hint alone does not establish trust.
        const key = await credentialKey("credential-1");
        await serveFederation({
            entity: ISSUER,
            trustAnchor: TRUST_ANCHOR,
            metadata: issuerMetadata(key.jwk),
            listed: false,
        });

        await expect(
            presentFederationCredential(key.privateKey, {
                kid: "credential-1",
            }),
        ).resolves.toMatchObject({
            status: "failed",
            failureCode: "no_trust_chain_to_root",
        });
    });

    test("rejects an SD-JWT whose issuer is in another federation", async () => {
        const key = await credentialKey("credential-1");
        await serveFederation({
            entity: ISSUER,
            trustAnchor: "https://other-ta.example.net",
            metadata: issuerMetadata(key.jwk),
        });

        await expect(
            presentFederationCredential(key.privateKey, {
                kid: "credential-1",
            }),
        ).resolves.toMatchObject({
            status: "failed",
            failureCode: "no_trust_chain_to_root",
        });
    });
});
