import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { createDpopHeadersForRequest, type Jwk } from "@openid4vc/oauth2";
import {
    calculateJwkThumbprint,
    decodeJwt,
    exportJWK,
    generateKeyPair,
    SignJWT,
} from "jose";
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
import { AppModule } from "../../src/app.module.js";
import { KeyChainImportDto } from "../../src/crypto/key/dto/key-chain-import.dto.js";
import { CredentialConfigCreate } from "../../src/issuer/configuration/credentials/dto/credential-config-create.dto.js";
import { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { SessionStore } from "../../src/session/application/session-store.js";
import { SessionStatus } from "../../src/session/domain/session-state.js";
import { PresentationConfigCreateDto } from "../../src/verifier/presentations/dto/presentation-config-create.dto.js";
import {
    callbacks,
    getSignJwtCallback,
    getToken,
    readConfig,
} from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

/**
 * Mock upstream OIDC provider configuration
 */
const UPSTREAM_ISSUER = "http://mock-keycloak:8080/realms/test";
const UPSTREAM_CLIENT_ID = "eudiplo-chained";
const UPSTREAM_CLIENT_SECRET = "test-secret";

/**
 * Sets up nock mocks for the upstream OIDC provider
 */
function setupUpstreamOidcMocks() {
    // Mock OIDC discovery endpoint
    nock(UPSTREAM_ISSUER)
        .get("/.well-known/openid-configuration")
        .reply(200, {
            issuer: UPSTREAM_ISSUER,
            authorization_endpoint: `${UPSTREAM_ISSUER}/protocol/openid-connect/auth`,
            token_endpoint: `${UPSTREAM_ISSUER}/protocol/openid-connect/token`,
            userinfo_endpoint: `${UPSTREAM_ISSUER}/protocol/openid-connect/userinfo`,
            jwks_uri: `${UPSTREAM_ISSUER}/protocol/openid-connect/certs`,
            scopes_supported: ["openid", "profile", "email"],
            response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: [
                "client_secret_post",
                "client_secret_basic",
            ],
        })
        .persist();
}

/**
 * Mock token response from upstream OIDC provider
 */
function mockUpstreamTokenResponse(idTokenClaims: Record<string, unknown>) {
    nock(UPSTREAM_ISSUER)
        .post("/protocol/openid-connect/token")
        .reply(200, {
            access_token: "mock-upstream-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            // For simplicity, use a base64-encoded fake ID token
            // In real scenario, this would be a proper JWT signed by the upstream OIDC
            id_token: createFakeIdToken(idTokenClaims),
        })
        .persist();
}

/**
 * Creates a fake ID token for testing (not cryptographically valid, but parseable)
 */
function createFakeIdToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(
        JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
        JSON.stringify({
            iss: UPSTREAM_ISSUER,
            aud: UPSTREAM_CLIENT_ID,
            sub: claims.sub || "test-user",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            ...claims,
        }),
    ).toString("base64url");
    return `${header}.${payload}.`;
}

async function holderKey() {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
        extractable: true,
    });
    return {
        privateKey,
        privateJwk: (await exportJWK(privateKey)) as Jwk,
        publicJwk: (await exportJWK(publicKey)) as Jwk,
    };
}

type HolderKey = Awaited<ReturnType<typeof holderKey>>;

/** A DPoP proof for a POST to `url`, created like a wallet does with the OAuth library. */
async function dpopProof(key: HolderKey, url: string): Promise<string> {
    const { DPoP } = await createDpopHeadersForRequest({
        request: { method: "POST", url },
        signer: { method: "jwk", alg: "ES256", publicJwk: key.publicJwk },
        callbacks: {
            ...callbacks,
            signJwt: getSignJwtCallback([key.privateJwk]),
        },
    });
    return DPoP;
}

/** A hand-made DPoP proof for a POST to `url`, to break single checks. */
function craftedDpopProof(
    key: HolderKey,
    url: string,
    {
        payload = {},
        signingKey = key.privateKey,
    }: {
        payload?: Record<string, unknown>;
        signingKey?: HolderKey["privateKey"];
    } = {},
): Promise<string> {
    return new SignJWT({
        htm: "POST",
        htu: url,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        ...payload,
    })
        .setProtectedHeader({
            alg: "ES256",
            typ: "dpop+jwt",
            jwk: key.publicJwk,
        })
        .sign(signingKey);
}

describe("Issuance - Chained AS Flow", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let clientId: string;
    let clientSecret: string;
    let publicUrl: string;
    let sessionStore: SessionStore;

    beforeAll(async () => {
        // Delete the database
        rmSync("../../tmp/service.db", { force: true });

        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe());

        const configService = app.get(ConfigService);
        configService.set("CONFIG_IMPORT_MODE", "disabled");
        configService.set("LOG_LEVEL", "debug");

        clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
        clientSecret = configService.getOrThrow<string>("AUTH_CLIENT_SECRET");
        publicUrl = configService.getOrThrow<string>("PUBLIC_URL");

        await app.init();

        sessionStore = app.get(SessionStore);

        authToken = await getToken(app, clientId, clientSecret, "haip");

        const configFolder = resolve(__dirname + "/../fixtures");

        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<KeyChainImportDto>(
                    join(configFolder, "haip/key-chains/access.json"),
                ),
            )
            .expect(201);

        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<KeyChainImportDto>(
                    join(configFolder, "haip/key-chains/attestation.json"),
                ),
            )
            .expect(201);

        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<KeyChainImportDto>(
                    join(configFolder, "haip/key-chains/status-list.json"),
                ),
            )
            .expect(201);

        await request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<KeyChainImportDto>(
                    join(configFolder, "haip/key-chains/trust-list.json"),
                ),
            )
            .expect(201);

        // Import image
        await request(app.getHttpServer())
            .post("/storage")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .attach("file", join(configFolder, "haip/images/company.png"))
            .expect(201);

        // Import issuance config (disable wallet attestation for non-OIDF tests)
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...readConfig<IssuanceDto>(
                    join(configFolder, "haip/issuance/issuance.json"),
                ),
                walletAttestationRequired: false,
                dPopRequired: false,
            })
            .expect(201);

        // Import the pid credential configuration
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<CredentialConfigCreate>(
                    join(
                        configFolder,
                        "haip/issuance/credentials/pid-no-key.json",
                    ),
                ),
            )
            .expect(201);
    });

    beforeEach(() => {
        // Enable nock to intercept HTTP requests
        nock.disableNetConnect();
        // Allow local connections for the test app
        nock.enableNetConnect(/127\.0\.0\.1|localhost/);
    });

    afterEach(() => {
        nock.cleanAll();
        nock.enableNetConnect();
    });

    afterAll(async () => {
        await app?.close();
    });

    async function configureChainedAs(
        refreshTokenEnabled = false,
    ): Promise<void> {
        // First get the current issuance config
        const currentConfigResponse = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);

        const currentConfig = currentConfigResponse.body;

        // Update issuance config with Chained AS settings (POST replaces the config)
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...currentConfig,
                authorizationServers: [
                    {
                        id: "chained-auth",
                        type: "chained",
                        enabled: true,
                        upstream: {
                            issuer: UPSTREAM_ISSUER,
                            clientId: UPSTREAM_CLIENT_ID,
                            clientSecret: UPSTREAM_CLIENT_SECRET,
                            scopes: ["openid", "profile", "email"],
                        },
                        token: {
                            lifetimeSeconds: 3600,
                            refreshTokenEnabled,
                        },
                        requireDPoP: false,
                    },
                ],
            })
            .expect(201);
    }

    test("rejects the removed OID4VP-backed chained authorization server", async () => {
        const response = await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                authorizationServers: [
                    {
                        id: "chained-auth",
                        type: "chained",
                        vp: {
                            enabled: true,
                            presentationConfigId: "pid-no-hook",
                        },
                    },
                ],
            })
            .expect(400);

        expect(response.body.message).toContain("'oid4vp'");
    });

    test("OID4VP authorization server binds the token to the PAR DPoP key", async () => {
        await request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<PresentationConfigCreateDto>(
                    join(
                        resolve(__dirname + "/../fixtures"),
                        "haip/presentation/pid-no-hook.json",
                    ),
                ),
            )
            .expect(201);
        const currentConfigResponse = await request(app.getHttpServer())
            .get("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        await request(app.getHttpServer())
            .post("/issuer/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...currentConfigResponse.body,
                authorizationServers: [
                    {
                        id: "vp-as",
                        type: "oid4vp",
                        presentationConfigId: "pid-no-hook",
                        token: { lifetimeSeconds: 3600 },
                        requireDPoP: false,
                    },
                ],
            })
            .expect(201);

        const path = "/issuers/haip/authorization-servers/vp-as";
        const key = await holderKey();
        const parResponse = await request(app.getHttpServer())
            .post(`${path}/par`)
            .trustLocalhost()
            .set("DPoP", await dpopProof(key, `${publicUrl}${path}/par`))
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
            })
            .expect(201);
        await request(app.getHttpServer())
            .get(`${path}/authorize`)
            .query({
                client_id: "test-wallet",
                request_uri: parResponse.body.request_uri,
            })
            .trustLocalhost()
            .expect(200);
        const sessionId = parResponse.body.request_uri.replace(
            "urn:ietf:params:oauth:request_uri:",
            "",
        );
        await sessionStore.updateForTenant("haip", sessionId, {
            status: SessionStatus.Completed,
            responseCode: "vp-response-code",
        });
        const callbackResponse = await request(app.getHttpServer())
            .get(`${path}/vp-callback`)
            .query({ cas: sessionId, response_code: "vp-response-code" })
            .trustLocalhost()
            .redirects(0)
            .expect(302);
        const tokenRequest = {
            grant_type: "authorization_code",
            code: new URL(callbackResponse.headers.location).searchParams.get(
                "code",
            ),
            redirect_uri: "http://wallet.example.com/callback",
            code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        };

        const otherKey = await request(app.getHttpServer())
            .post(`${path}/token`)
            .trustLocalhost()
            .set(
                "DPoP",
                await dpopProof(await holderKey(), `${publicUrl}${path}/token`),
            )
            .send(tokenRequest)
            .expect(400);
        expect(otherKey.body.error).toBe("invalid_dpop_proof");

        const tokenResponse = await request(app.getHttpServer())
            .post(`${path}/token`)
            .trustLocalhost()
            .set("DPoP", await dpopProof(key, `${publicUrl}${path}/token`))
            .send(tokenRequest)
            .expect(200);
        expect(tokenResponse.body.token_type).toBe("DPoP");
        expect(decodeJwt(tokenResponse.body.access_token).cnf).toEqual({
            jkt: await calculateJwkThumbprint(key.publicJwk, "sha256"),
        });
    });

    test("token endpoint supports refresh_token grant in Chained AS flow", async () => {
        setupUpstreamOidcMocks();
        mockUpstreamTokenResponse({ sub: "refresh-token-user" });
        await configureChainedAs(true);

        // Complete the Chained AS authorization_code flow to get initial tokens
        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
            })
            .expect(201);

        const authorizeResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/authorize")
            .query({
                client_id: "test-wallet",
                request_uri: parResponse.body.request_uri,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const upstreamUrl = new URL(authorizeResponse.headers.location);
        const upstreamState = upstreamUrl.searchParams.get("state")!;

        const callbackResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/callback")
            .query({
                code: "upstream-auth-code",
                state: upstreamState,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const walletRedirectUrl = new URL(callbackResponse.headers.location);
        const authorizationCode = walletRedirectUrl.searchParams.get("code")!;

        const initialTokenResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/token")
            .trustLocalhost()
            .send({
                grant_type: "authorization_code",
                code: authorizationCode,
                redirect_uri: "http://wallet.example.com/callback",
                code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
            })
            .expect(200);

        expect(initialTokenResponse.body.refresh_token).toBeDefined();
        expect(typeof initialTokenResponse.body.refresh_token).toBe("string");

        const refreshToken = initialTokenResponse.body.refresh_token;

        // Exchange refresh token for a new access token
        const refreshedTokenResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/token")
            .trustLocalhost()
            .send({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
            })
            .expect(200);

        expect(refreshedTokenResponse.body.access_token).toBeDefined();
        expect(refreshedTokenResponse.body.token_type).toBe("Bearer");
        expect(refreshedTokenResponse.body.refresh_token).toBeDefined();
        expect(refreshedTokenResponse.body.refresh_token).not.toBe(
            refreshToken,
        );

        const refreshedTokenPayload = decodeJwt(
            refreshedTokenResponse.body.access_token,
        );
        expect(refreshedTokenPayload.issuer_state).toBeDefined();
    });

    test("disabled refresh tokens are neither advertised nor accepted in Chained AS flow", async () => {
        await configureChainedAs(false);

        const metadataResponse = await request(app.getHttpServer())
            .get(
                "/.well-known/oauth-authorization-server/issuers/haip/chained-as",
            )
            .trustLocalhost()
            .expect(200);
        expect(metadataResponse.body.grant_types_supported).toEqual([
            "authorization_code",
        ]);

        const refreshResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/token")
            .trustLocalhost()
            .send({
                grant_type: "refresh_token",
                refresh_token: "any-refresh-token",
            })
            .expect(400);
        expect(refreshResponse.body.error).toBe("unsupported_grant_type");
    });

    test("chained AS metadata endpoint returns correct configuration", async () => {
        await configureChainedAs();

        const metadataResponse = await request(app.getHttpServer())
            .get(
                "/.well-known/oauth-authorization-server/issuers/haip/chained-as",
            )
            .trustLocalhost()
            .expect(200);

        expect(metadataResponse.body.issuer).toContain(
            "/issuers/haip/chained-as",
        );
        expect(metadataResponse.body.authorization_endpoint).toContain(
            "/issuers/haip/chained-as/authorize",
        );
        expect(metadataResponse.body.token_endpoint).toContain(
            "/issuers/haip/chained-as/token",
        );
        expect(
            metadataResponse.body.pushed_authorization_request_endpoint,
        ).toContain("/issuers/haip/chained-as/par");
        expect(metadataResponse.body.response_types_supported).toContain(
            "code",
        );
        expect(metadataResponse.body.grant_types_supported).toContain(
            "authorization_code",
        );
        expect(metadataResponse.body.code_challenge_methods_supported).toEqual([
            "S256",
        ]);
    });

    test("PAR endpoint accepts authorization request and returns request_uri", async () => {
        setupUpstreamOidcMocks();
        await configureChainedAs();

        // Submit PAR request (without issuer_state - service generates one)
        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
                scope: "openid pid",
            })
            .expect(201);

        expect(parResponse.body.request_uri).toBeDefined();
        expect(parResponse.body.request_uri).toMatch(
            /^urn:ietf:params:oauth:request_uri:/,
        );
        expect(parResponse.body.expires_in).toBeGreaterThan(0);
    });

    test("PAR endpoint rejects a request without code_challenge", async () => {
        setupUpstreamOidcMocks();
        await configureChainedAs();

        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                scope: "openid pid",
            })
            .expect(400);

        expect(parResponse.body.error).toBe("invalid_request");
        expect(parResponse.body.error_description).toContain("code_challenge");
    });

    test("PAR endpoint rejects code_challenge_method plain", async () => {
        setupUpstreamOidcMocks();
        await configureChainedAs();

        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
                code_challenge_method: "plain",
                scope: "openid pid",
            })
            .expect(400);

        expect(parResponse.body.error).toBe("invalid_request");
        expect(parResponse.body.error_description).toContain("S256");
    });

    test("authorize endpoint redirects to upstream OIDC provider", async () => {
        setupUpstreamOidcMocks();
        await configureChainedAs();

        // Submit PAR (without issuer_state)
        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
            })
            .expect(201);

        // Call authorize endpoint - should redirect to upstream
        const authorizeResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/authorize")
            .query({
                client_id: "test-wallet",
                request_uri: parResponse.body.request_uri,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        // Should redirect to upstream OIDC provider
        expect(authorizeResponse.headers.location).toContain(UPSTREAM_ISSUER);
        expect(authorizeResponse.headers.location).toContain(
            "response_type=code",
        );
        expect(authorizeResponse.headers.location).toContain(
            `client_id=${UPSTREAM_CLIENT_ID}`,
        );
    });

    test("callback exchanges upstream code and redirects wallet with code", async () => {
        setupUpstreamOidcMocks();
        mockUpstreamTokenResponse({
            sub: "user-456",
            given_name: "Jane",
            family_name: "Smith",
            email: "jane.smith@example.com",
        });
        await configureChainedAs();

        // Submit PAR (without issuer_state)
        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
                state: "wallet-state-123",
            })
            .expect(201);

        // Get authorize redirect to extract upstream state
        const authorizeResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/authorize")
            .query({
                client_id: "test-wallet",
                request_uri: parResponse.body.request_uri,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const upstreamUrl = new URL(authorizeResponse.headers.location);
        const upstreamState = upstreamUrl.searchParams.get("state")!;

        // Simulate upstream callback
        const callbackResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/callback")
            .query({
                code: "upstream-auth-code",
                state: upstreamState,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        // Should redirect back to wallet with our code
        const walletRedirectUrl = new URL(callbackResponse.headers.location);
        expect(walletRedirectUrl.origin).toBe("http://wallet.example.com");
        expect(walletRedirectUrl.searchParams.get("state")).toBe(
            "wallet-state-123",
        );
        expect(walletRedirectUrl.searchParams.get("code")).toBeDefined();
    });

    test("token endpoint issues access token with issuer_state", async () => {
        setupUpstreamOidcMocks();
        mockUpstreamTokenResponse({
            sub: "user-789",
            given_name: "Bob",
            family_name: "Wilson",
        });
        await configureChainedAs();

        // Full flow to get a code (without issuer_state)
        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
                state: "wallet-state",
            })
            .expect(201);

        const authorizeResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/authorize")
            .query({
                client_id: "test-wallet",
                request_uri: parResponse.body.request_uri,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const upstreamUrl = new URL(authorizeResponse.headers.location);
        const upstreamState = upstreamUrl.searchParams.get("state")!;

        const callbackResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/callback")
            .query({
                code: "upstream-auth-code",
                state: upstreamState,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const walletRedirectUrl = new URL(callbackResponse.headers.location);
        const authorizationCode = walletRedirectUrl.searchParams.get("code")!;

        // Exchange code for token
        const tokenResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/token")
            .trustLocalhost()
            .send({
                grant_type: "authorization_code",
                code: authorizationCode,
                redirect_uri: "http://wallet.example.com/callback",
                code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
            })
            .expect(200);

        expect(tokenResponse.body.access_token).toBeDefined();
        expect(tokenResponse.body.token_type).toBe("Bearer");

        // Verify the token contains issuer_state
        const tokenPayload = decodeJwt(tokenResponse.body.access_token);
        expect(tokenPayload.issuer_state).toBeDefined();
    });

    test("token endpoint validates PKCE code verifier", async () => {
        setupUpstreamOidcMocks();
        mockUpstreamTokenResponse({ sub: "pkce-test-user" });
        await configureChainedAs();

        // Get a valid code through the flow (without issuer_state)
        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
            })
            .expect(201);

        const authorizeResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/authorize")
            .query({
                client_id: "test-wallet",
                request_uri: parResponse.body.request_uri,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const upstreamUrl = new URL(authorizeResponse.headers.location);
        const upstreamState = upstreamUrl.searchParams.get("state")!;

        const callbackResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/callback")
            .query({
                code: "upstream-auth-code",
                state: upstreamState,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const walletRedirectUrl = new URL(callbackResponse.headers.location);
        const authorizationCode = walletRedirectUrl.searchParams.get("code")!;

        // Try to exchange with wrong code verifier
        const tokenResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/token")
            .trustLocalhost()
            .send({
                grant_type: "authorization_code",
                code: authorizationCode,
                redirect_uri: "http://wallet.example.com/callback",
                code_verifier: "wrong-code-verifier",
            })
            .expect(401);

        expect(tokenResponse.body.error).toBeDefined();
    });

    test("callback handles upstream errors gracefully", async () => {
        setupUpstreamOidcMocks();
        await configureChainedAs();

        // Submit PAR (without issuer_state)
        const parResponse = await request(app.getHttpServer())
            .post("/issuers/haip/chained-as/par")
            .trustLocalhost()
            .send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
                state: "wallet-state-error",
            })
            .expect(201);

        // Get authorize redirect to extract upstream state
        const authorizeResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/authorize")
            .query({
                client_id: "test-wallet",
                request_uri: parResponse.body.request_uri,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        const upstreamUrl = new URL(authorizeResponse.headers.location);
        const upstreamState = upstreamUrl.searchParams.get("state")!;

        // Simulate upstream error callback
        const callbackResponse = await request(app.getHttpServer())
            .get("/issuers/haip/chained-as/callback")
            .query({
                error: "access_denied",
                error_description: "User denied access",
                state: upstreamState,
            })
            .trustLocalhost()
            .redirects(0)
            .expect(302);

        // Should redirect back to wallet with error
        const walletRedirectUrl = new URL(callbackResponse.headers.location);
        expect(walletRedirectUrl.origin).toBe("http://wallet.example.com");
        expect(walletRedirectUrl.searchParams.get("error")).toBe(
            "access_denied",
        );
        expect(walletRedirectUrl.searchParams.get("error_description")).toBe(
            "User denied access",
        );
        expect(walletRedirectUrl.searchParams.get("state")).toBe(
            "wallet-state-error",
        );
    });

    describe("DPoP", () => {
        const parUrl = () => `${publicUrl}/issuers/haip/chained-as/par`;
        const tokenUrl = () => `${publicUrl}/issuers/haip/chained-as/token`;

        const par = (dpop?: string) => {
            const req = request(app.getHttpServer())
                .post("/issuers/haip/chained-as/par")
                .trustLocalhost();
            if (dpop) req.set("DPoP", dpop);
            return req.send({
                response_type: "code",
                client_id: "test-wallet",
                redirect_uri: "http://wallet.example.com/callback",
                code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                code_challenge_method: "S256",
            });
        };

        /** PAR, authorization and upstream callback; returns the wallet's code. */
        async function authorizationCode(parDpop?: string): Promise<string> {
            const parResponse = await par(parDpop).expect(201);
            const authorizeResponse = await request(app.getHttpServer())
                .get("/issuers/haip/chained-as/authorize")
                .query({
                    client_id: "test-wallet",
                    request_uri: parResponse.body.request_uri,
                })
                .trustLocalhost()
                .redirects(0)
                .expect(302);
            const callbackResponse = await request(app.getHttpServer())
                .get("/issuers/haip/chained-as/callback")
                .query({
                    code: "upstream-auth-code",
                    state: new URL(
                        authorizeResponse.headers.location,
                    ).searchParams.get("state"),
                })
                .trustLocalhost()
                .redirects(0)
                .expect(302);
            return new URL(callbackResponse.headers.location).searchParams.get(
                "code",
            )!;
        }

        const token = (body: Record<string, string>, dpop?: string) => {
            const req = request(app.getHttpServer())
                .post("/issuers/haip/chained-as/token")
                .trustLocalhost();
            if (dpop) req.set("DPoP", dpop);
            return req.send(body);
        };

        const codeGrant = (code: string) => ({
            grant_type: "authorization_code",
            code,
            redirect_uri: "http://wallet.example.com/callback",
            code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        });

        beforeEach(async () => {
            setupUpstreamOidcMocks();
            mockUpstreamTokenResponse({ sub: "dpop-user" });
            await configureChainedAs(true);
        });

        test("binds the access and refresh token to the verified DPoP key", async () => {
            const key = await holderKey();
            const code = await authorizationCode(
                await dpopProof(key, parUrl()),
            );

            const tokenResponse = await token(
                codeGrant(code),
                await dpopProof(key, tokenUrl()),
            ).expect(200);
            expect(tokenResponse.body.token_type).toBe("DPoP");
            expect(decodeJwt(tokenResponse.body.access_token).cnf).toEqual({
                jkt: await calculateJwkThumbprint(key.publicJwk, "sha256"),
            });

            const refreshGrant = {
                grant_type: "refresh_token",
                refresh_token: tokenResponse.body.refresh_token,
            };
            const withoutProof = await token(refreshGrant).expect(400);
            expect(withoutProof.body.error).toBe("invalid_dpop_proof");
            const otherKey = await token(
                refreshGrant,
                await dpopProof(await holderKey(), tokenUrl()),
            ).expect(400);
            expect(otherKey.body.error).toBe("invalid_dpop_proof");

            const refreshed = await token(
                refreshGrant,
                await dpopProof(key, tokenUrl()),
            ).expect(200);
            expect(refreshed.body.token_type).toBe("DPoP");
        });

        test.each<[string, (key: HolderKey) => Promise<string>]>([
            [
                "a forged signature",
                async (key) =>
                    craftedDpopProof(key, parUrl(), {
                        signingKey: (await holderKey()).privateKey,
                    }),
            ],
            [
                "the wrong htm",
                (key) =>
                    craftedDpopProof(key, parUrl(), {
                        payload: { htm: "GET" },
                    }),
            ],
            ["the wrong htu", (key) => craftedDpopProof(key, tokenUrl())],
            [
                "a stale iat",
                (key) =>
                    craftedDpopProof(key, parUrl(), {
                        payload: { iat: Math.floor(Date.now() / 1000) - 3600 },
                    }),
            ],
            [
                "no signature",
                async (key) => {
                    const [, payload] = (
                        await craftedDpopProof(key, parUrl())
                    ).split(".");
                    const header = Buffer.from(
                        JSON.stringify({
                            alg: "none",
                            typ: "dpop+jwt",
                            jwk: key.publicJwk,
                        }),
                    ).toString("base64url");
                    return `${header}.${payload}.`;
                },
            ],
            ["a malformed value", async () => "not-a-dpop-proof"],
        ])("rejects a PAR DPoP proof with %s", async (_, createProof) => {
            const response = await par(
                await createProof(await holderKey()),
            ).expect(400);
            expect(response.body.error).toBe("invalid_dpop_proof");
        });

        test("rejects a replayed PAR DPoP proof", async () => {
            const proof = await dpopProof(await holderKey(), parUrl());
            await par(proof).expect(201);

            const replay = await par(proof).expect(400);
            expect(replay.body.error).toBe("invalid_dpop_proof");
        });

        test("requires a DPoP proof with the PAR-bound key at the token endpoint", async () => {
            const key = await holderKey();
            const code = await authorizationCode(
                await dpopProof(key, parUrl()),
            );

            const withoutProof = await token(codeGrant(code)).expect(400);
            expect(withoutProof.body.error).toBe("invalid_dpop_proof");
            const otherKey = await token(
                codeGrant(code),
                await dpopProof(await holderKey(), tokenUrl()),
            ).expect(400);
            expect(otherKey.body.error).toBe("invalid_dpop_proof");

            await token(codeGrant(code), await dpopProof(key, tokenUrl()))
                .expect(200)
                .expect(({ body }) => expect(body.token_type).toBe("DPoP"));
        });

        test("never issues a DPoP token for an invalid proof", async () => {
            const forged = await craftedDpopProof(
                await holderKey(),
                tokenUrl(),
                { signingKey: (await holderKey()).privateKey },
            );

            const response = await token(
                codeGrant(await authorizationCode()),
                forged,
            ).expect(400);
            expect(response.body.error).toBe("invalid_dpop_proof");
        });

        test("rejects a replayed DPoP proof at the token endpoint", async () => {
            const proof = await dpopProof(await holderKey(), tokenUrl());
            await token(codeGrant(await authorizationCode()), proof).expect(
                200,
            );

            const replay = await token(
                codeGrant(await authorizationCode()),
                proof,
            ).expect(400);
            expect(replay.body.error).toBe("invalid_dpop_proof");
        });
    });
});
