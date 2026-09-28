import { HttpException } from "@nestjs/common";
import {
    Oauth2AuthorizationServer,
    Oauth2ServerErrorResponseError,
} from "@openid4vc/oauth2";
import { calculateJwkThumbprint } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../../session/domain/session-data.js";
import {
    ConfiguredBuiltInAuthorizationServerConfiguration,
    KeyChainAccessTokenSigningKeys,
    WalletAttestationClientVerifier,
} from "../adapters/built-in-authorization-server.adapters.js";
import { AuthorizePushedRequest } from "../application/authorize-pushed-request.js";
import { BuildBuiltInAuthorizationServerMetadata } from "../application/build-built-in-authorization-server-metadata.js";
import { ExchangeAccessToken } from "../application/exchange-access-token.js";
import { PushAuthorizationRequest } from "../application/push-authorization-request.js";
import { AuthorizeController } from "./authorize.controller.js";
import { AuthorizeService } from "./authorize.service.js";

/**
 * Characterization of the built-in authorization server endpoints: token,
 * PAR, authorize and challenge. The expectations pin the exact HTTP status and
 * body of every OAuth error, so the extraction into use cases can be proven
 * behavior-preserving.
 */

const PUBLIC_URL = "https://issuer.example";
const TENANT = "tenant-1";
const ISSUER = `${PUBLIC_URL}/issuers/${TENANT}`;
const CLIENT_KEY = {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};

const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
    `${b64({ alg: "ES256", typ: "JWT" })}.${b64(payload)}.c2ln`;

const ATTESTATION = jwt({
    iss: "https://wallet-provider.example",
    sub: "wallet-client",
    cnf: { jwk: CLIENT_KEY },
});
const ATTESTATION_POP = jwt({ iss: "wallet-client", aud: ISSUER });

function session(overrides: Partial<SessionData> = {}): SessionData {
    return {
        id: "session-1",
        tenantId: TENANT,
        createdAt: new Date(),
        updatedAt: new Date(),
        useDcApi: false,
        status: "active",
        notifications: [],
        txCodeFailedAttempts: 0,
        consumed: false,
        authorization_code: "code-1",
        ...overrides,
    } as SessionData;
}

function request(headers: Record<string, string> = {}, url = "/token") {
    return {
        body: undefined,
        contentType: "application/x-www-form-urlencoded",
        headers: { host: "issuer.example", ...headers },
        method: "POST",
        url,
    };
}

type Outcome =
    | { status: number; body: unknown }
    | { value: unknown }
    | { thrown: unknown };

async function outcome(promise: Promise<unknown>): Promise<Outcome> {
    try {
        return { value: await promise };
    } catch (error) {
        if (error instanceof HttpException)
            return { status: error.getStatus(), body: error.getResponse() };
        return { thrown: error };
    }
}

function createHarness(issuanceConfig: Record<string, unknown> = {}) {
    const server = new Oauth2AuthorizationServer({ callbacks: {} as never });
    const oauth = {
        verifyAuthorizationCodeAccessTokenRequest: vi
            .fn()
            .mockResolvedValue({ dpop: { jwkThumbprint: "dpop-jkt" } }),
        verifyPreAuthorizedCodeAccessTokenRequest: vi
            .fn()
            .mockResolvedValue({ dpop: undefined }),
        verifyRefreshTokenAccessTokenRequest: vi
            .fn()
            .mockResolvedValue({ dpop: { jwkThumbprint: "dpop-jkt" } }),
        verifyPushedAuthorizationRequest: vi
            .fn()
            .mockResolvedValue({ dpop: { jwkThumbprint: "par-jkt" } }),
        createAccessTokenResponse: vi.fn().mockResolvedValue({
            access_token: "access-token",
            token_type: "DPoP",
            expires_in: 300,
            refresh_token: "refresh-token",
        }),
        createAuthorizationServerMetadata: vi.fn(
            (metadata: Record<string, unknown>) => metadata,
        ),
    };
    Object.assign(server, oauth);

    const sessions = {
        getByAuthorizationCode: vi.fn().mockResolvedValue(session()),
        getByRefreshToken: vi.fn(),
        getByRequestUri: vi.fn(),
        updateForTenant: vi.fn().mockResolvedValue(true),
        updateIfUnconsumed: vi.fn().mockResolvedValue(true),
    };
    const createSession = { execute: vi.fn().mockResolvedValue(undefined) };
    const recordFailedTxCodeAttempt = { execute: vi.fn() };
    const walletAttestation = {
        verifyWalletAttestation: vi.fn().mockResolvedValue(undefined),
    };
    const keyChain = {
        getKid: vi.fn().mockResolvedValue("kid-1"),
        getPublicKey: vi.fn().mockResolvedValue({ kty: "EC", kid: "kid-1" }),
    };
    const nonces = { save: vi.fn().mockResolvedValue(undefined) };
    const issuance = {
        getIssuanceConfiguration: vi.fn().mockResolvedValue({
            authorizationServers: [],
            dPopRequired: false,
            ...issuanceConfig,
        }),
    };
    const statusLists = {
        getEffectiveConfig: vi
            .fn()
            .mockResolvedValue({ enableAggregation: false }),
    };

    // Real use cases and controller; only the outbound ports are faked.
    const settings = { publicUrl: PUBLIC_URL };
    const servers = { forTenant: () => server };
    const configuration = new ConfiguredBuiltInAuthorizationServerConfiguration(
        issuance as never,
        statusLists as never,
    );
    const clientAttestation = new WalletAttestationClientVerifier(
        walletAttestation as never,
    );
    const metadata = new BuildBuiltInAuthorizationServerMetadata(
        configuration,
        servers,
        settings,
    );
    const authorizeService = new AuthorizeService(
        settings,
        metadata,
        nonces as never,
    );
    const controller = new AuthorizeController(
        authorizeService,
        new AuthorizePushedRequest(sessions as never, settings),
        new PushAuthorizationRequest(
            servers,
            sessions as never,
            createSession as never,
            configuration,
            metadata,
            clientAttestation,
        ),
        new ExchangeAccessToken(
            servers,
            sessions as never,
            recordFailedTxCodeAttempt,
            configuration,
            metadata,
            clientAttestation,
            new KeyChainAccessTokenSigningKeys(keyChain as never),
            settings,
        ),
        settings,
    );
    type Req = ReturnType<typeof request>;
    // Endpoint entry points under the names of the former AuthorizeService.
    const service = {
        validateTokenRequest: (body: unknown, req: Req, tenantId: string) =>
            controller.token(body, req as never, tenantId),
        handlePar: (tenantId: string, body: never, req: Req) =>
            controller.par(
                tenantId,
                body,
                req as never,
                req.headers["oauth-client-attestation"],
                req.headers["oauth-client-attestation-pop"],
            ),
        sendAuthorizationResponse: async (
            values: Record<string, unknown>,
            tenantId: string,
        ) => {
            let location = "";
            await controller.authorize(
                values as never,
                {
                    redirect: (url: string) => {
                        location = url;
                    },
                } as never,
                tenantId,
            );
            return location;
        },
        authzMetadata: (tenantId: string) =>
            authorizeService.authzMetadata(tenantId),
        challengeRequest: (tenantId: string) =>
            authorizeService.challengeRequest(tenantId),
    };

    return {
        service,
        oauth,
        sessions,
        createSession,
        recordFailedTxCodeAttempt,
        walletAttestation,
        keyChain,
        nonces,
        issuance,
    };
}

type Harness = ReturnType<typeof createHarness>;

const tokenError = (
    error: string,
    error_description?: string,
    status = 400,
) => ({
    status,
    body: error_description ? { error, error_description } : { error },
});

describe("Built-in authorization server token endpoint", () => {
    let h: Harness;
    const token = (body: Record<string, unknown>, headers = {}) =>
        outcome(h.service.validateTokenRequest(body, request(headers), TENANT));

    beforeEach(() => {
        h = createHarness();
    });

    describe("request parsing", () => {
        it("rejects a body without grant_type as invalid_request", async () => {
            const result = await token({});
            expect(result).toMatchObject({
                status: 400,
                body: {
                    error: "invalid_request",
                    error_description: expect.stringContaining(
                        "Error occurred during validation of authorization request.",
                    ),
                },
            });
            expect(h.sessions.getByAuthorizationCode).not.toHaveBeenCalled();
        });

        it("rejects a missing code with the library description", async () => {
            expect(await token({ grant_type: "authorization_code" })).toEqual(
                tokenError(
                    "invalid_request",
                    "Missing required 'code' for grant type 'authorization_code'",
                ),
            );
        });

        it("maps an unsupported grant type to invalid_request", async () => {
            expect(await token({ grant_type: "password" })).toEqual(
                tokenError(
                    "invalid_request",
                    "The grant type 'password' is not supported",
                ),
            );
        });

        it("rejects a malformed DPoP header as invalid_request", async () => {
            expect(
                await token(
                    { grant_type: "authorization_code", code: "code-1" },
                    { dpop: "not-a-jwt" },
                ),
            ).toEqual(
                tokenError(
                    "invalid_request",
                    "Request contains a 'DPoP' header, but the value is not a valid DPoP jwt",
                ),
            );
        });
    });

    describe("session lookup", () => {
        it("rejects an unknown authorization code", async () => {
            h.sessions.getByAuthorizationCode.mockRejectedValue(
                new Error("not found"),
            );
            expect(
                await token({ grant_type: "authorization_code", code: "x" }),
            ).toEqual(
                tokenError(
                    "invalid_grant",
                    "The provided authorization code is invalid or expired",
                ),
            );
            expect(h.sessions.getByAuthorizationCode).toHaveBeenCalledWith(
                TENANT,
                "x",
            );
        });

        it("looks up pre-authorized codes by authorization code", async () => {
            h.sessions.getByAuthorizationCode.mockRejectedValue(
                new Error("not found"),
            );
            expect(
                await token({
                    grant_type:
                        "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                    "pre-authorized_code": "pre-1",
                }),
            ).toEqual(
                tokenError(
                    "invalid_grant",
                    "The provided authorization code is invalid or expired",
                ),
            );
            expect(h.sessions.getByAuthorizationCode).toHaveBeenCalledWith(
                TENANT,
                "pre-1",
            );
        });

        it("rejects an unknown refresh token", async () => {
            h.sessions.getByRefreshToken.mockRejectedValue(new Error("nope"));
            expect(
                await token({
                    grant_type: "refresh_token",
                    refresh_token: "rt",
                }),
            ).toEqual(
                tokenError(
                    "invalid_grant",
                    "The provided refresh_token is invalid or expired",
                ),
            );
        });

        it("rejects a consumed session for code grants", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(
                session({ consumed: true }),
            );
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(
                tokenError(
                    "invalid_grant",
                    "The credential offer has already been used",
                ),
            );
            expect(h.issuance.getIssuanceConfiguration).not.toHaveBeenCalled();
        });

        it("allows a consumed session for the refresh grant", async () => {
            h.sessions.getByRefreshToken.mockResolvedValue(
                session({ consumed: true, refresh_token: "rt" }),
            );
            const result = await token({
                grant_type: "refresh_token",
                refresh_token: "rt",
            });
            expect(result).toEqual({
                value: expect.objectContaining({
                    access_token: "access-token",
                }),
            });
        });
    });

    describe("client authentication and binding", () => {
        it("returns 401 invalid_client with the attestation error message", async () => {
            h.walletAttestation.verifyWalletAttestation.mockRejectedValue(
                new Error("Wallet attestation is required"),
            );
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(
                tokenError(
                    "invalid_client",
                    "Wallet attestation is required",
                    401,
                ),
            );
        });

        it("uses a generic description for non-Error attestation failures", async () => {
            h.walletAttestation.verifyWalletAttestation.mockRejectedValue(
                "boom",
            );
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(
                tokenError(
                    "invalid_client",
                    "Client attestation validation failed",
                    401,
                ),
            );
        });

        it("passes the attestation policy and issuer to the verifier", async () => {
            h = createHarness({
                walletAttestationRequired: false,
                authorizationServers: [
                    {
                        type: "built-in",
                        walletAttestationRequired: true,
                        walletProviderTrustLists: [{ url: "https://tl" }],
                    },
                ],
            });
            await token(
                { grant_type: "authorization_code", code: "c" },
                {
                    "oauth-client-attestation": ATTESTATION,
                    "oauth-client-attestation-pop": ATTESTATION_POP,
                },
            );
            expect(
                h.walletAttestation.verifyWalletAttestation,
            ).toHaveBeenCalledWith(
                TENANT,
                {
                    clientAttestationJwt: ATTESTATION,
                    clientAttestationPopJwt: ATTESTATION_POP,
                },
                ISSUER,
                true,
                [{ url: "https://tl" }],
            );
        });

        it("rejects a refresh token bound to another client instance key", async () => {
            h.sessions.getByRefreshToken.mockResolvedValue(
                session({ client_key_jkt: "other-key" }),
            );
            expect(
                await token(
                    { grant_type: "refresh_token", refresh_token: "rt" },
                    {
                        "oauth-client-attestation": ATTESTATION,
                        "oauth-client-attestation-pop": ATTESTATION_POP,
                    },
                ),
            ).toEqual(
                tokenError(
                    "invalid_grant",
                    "The refresh_token is bound to a different client instance",
                ),
            );
        });

        it("rejects a client_id that differs from the attested client", async () => {
            expect(
                await token(
                    {
                        grant_type: "authorization_code",
                        code: "c",
                        client_id: "other-client",
                    },
                    {
                        "oauth-client-attestation": ATTESTATION,
                        "oauth-client-attestation-pop": ATTESTATION_POP,
                    },
                ),
            ).toEqual(
                tokenError(
                    "invalid_client",
                    "client_id does not match the client attestation",
                ),
            );
        });

        it("rejects a code issued to another client", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(
                session({ auth_queries: { client_id: "client-a" } }),
            );
            expect(
                await token({
                    grant_type: "authorization_code",
                    code: "c",
                    client_id: "client-b",
                }),
            ).toEqual(
                tokenError(
                    "invalid_grant",
                    "The authorization code was issued to another client",
                ),
            );
        });

        it("does not check the client binding for pre-authorized codes", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(
                session({ auth_queries: { client_id: "client-a" } }),
            );
            const result = await token({
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                "pre-authorized_code": "code-1",
                client_id: "client-b",
            });
            expect(result).toHaveProperty("value");
        });
    });

    describe("PKCE", () => {
        const challenged = () =>
            session({
                auth_queries: {
                    client_id: "client-a",
                    code_challenge:
                        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                    code_challenge_method: "S256",
                },
            });

        it("rejects a missing code_verifier", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(challenged());
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(tokenError("invalid_grant", "PKCE verification failed"));
        });

        it("rejects a wrong code_verifier", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(challenged());
            expect(
                await token({
                    grant_type: "authorization_code",
                    code: "c",
                    code_verifier: "wrong",
                }),
            ).toEqual(tokenError("invalid_grant", "PKCE verification failed"));
            expect(
                h.oauth.verifyAuthorizationCodeAccessTokenRequest,
            ).not.toHaveBeenCalled();
        });

        it("accepts the matching S256 code_verifier", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(challenged());
            const result = await token({
                grant_type: "authorization_code",
                code: "c",
                code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
            });
            expect(result).toHaveProperty("value");
        });

        it("compares plain challenges literally", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(
                session({
                    auth_queries: {
                        code_challenge: "verifier",
                        code_challenge_method: "plain",
                    },
                }),
            );
            const result = await token({
                grant_type: "authorization_code",
                code: "c",
                code_verifier: "verifier",
            });
            expect(result).toHaveProperty("value");
        });
    });

    describe("pre-authorized code and tx_code lockout", () => {
        const preAuth = (tx_code?: string) => ({
            grant_type: "urn:ietf:params:oauth:grant-type:pre-authorized_code",
            "pre-authorized_code": "code-1",
            ...(tx_code ? { tx_code } : {}),
        });
        const withTxCode = (txCodeFailedAttempts = 0) =>
            session({
                credentialPayload: { tx_code: "1234" } as never,
                txCodeFailedAttempts,
            });

        it("rejects a locked session before verifying", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(withTxCode(5));
            expect(await token(preAuth("1234"))).toEqual(
                tokenError(
                    "invalid_grant",
                    "Too many failed tx_code attempts. The pre-authorized code has been invalidated.",
                ),
            );
            expect(
                h.oauth.verifyPreAuthorizedCodeAccessTokenRequest,
            ).not.toHaveBeenCalled();
        });

        it("uses the configured maximum attempts", async () => {
            h = createHarness({ txCodeMaxAttempts: 3 });
            h.sessions.getByAuthorizationCode.mockResolvedValue(withTxCode(3));
            expect(await token(preAuth("1234"))).toMatchObject({
                body: { error: "invalid_grant" },
            });
        });

        it("ignores the counter when the offer has no tx_code", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(
                session({ txCodeFailedAttempts: 10 }),
            );
            expect(await token(preAuth())).toHaveProperty("value");
        });

        it("passes the expected codes and DPoP policy to the library", async () => {
            h = createHarness({ dPopRequired: true });
            h.sessions.getByAuthorizationCode.mockResolvedValue(withTxCode());
            await token(preAuth("1234"));
            expect(
                h.oauth.verifyPreAuthorizedCodeAccessTokenRequest,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    grant: {
                        grantType:
                            "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                        preAuthorizedCode: "code-1",
                        txCode: "1234",
                    },
                    expectedPreAuthorizedCode: "code-1",
                    expectedTxCode: "1234",
                    dpop: {
                        required: true,
                        allowedSigningAlgs: ["ES256", "ES384", "ES512"],
                        jwt: undefined,
                    },
                    request: expect.objectContaining({
                        method: "POST",
                        url: `${PUBLIC_URL}/token`,
                    }),
                }),
            );
        });

        // Errors are thrown in the exact shape of the real OAuth library.
        const libraryError = (error: string, description: string) =>
            new Oauth2ServerErrorResponseError({
                error,
                error_description: description,
            });

        it("counts a wrong tx_code and returns invalid_grant", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(withTxCode());
            h.oauth.verifyPreAuthorizedCodeAccessTokenRequest.mockRejectedValue(
                libraryError("invalid_grant", "Invalid 'tx_code' provided"),
            );
            h.recordFailedTxCodeAttempt.execute.mockResolvedValue({
                failedAttempts: 1,
                locked: false,
            });
            expect(await token(preAuth("9999"))).toEqual(
                tokenError("invalid_grant", "Invalid 'tx_code' provided"),
            );
            expect(h.recordFailedTxCodeAttempt.execute).toHaveBeenCalledWith(
                TENANT,
                "session-1",
                5,
            );
        });

        it("locks the code when the attempt reaches the limit", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(withTxCode(4));
            h.oauth.verifyPreAuthorizedCodeAccessTokenRequest.mockRejectedValue(
                libraryError("invalid_grant", "Invalid 'tx_code' provided"),
            );
            h.recordFailedTxCodeAttempt.execute.mockResolvedValue({
                failedAttempts: 5,
                locked: true,
            });
            expect(await token(preAuth("9999"))).toEqual(
                tokenError(
                    "invalid_grant",
                    "Too many failed tx_code attempts. The pre-authorized code has been invalidated.",
                ),
            );
        });

        it.each([
            ["invalid_dpop_proof", "Invalid DPoP proof"],
            ["invalid_client", "Invalid client attestation"],
            ["invalid_request", "Missing required 'tx_code' in request"],
        ])(
            "does not count a %s failure as a tx_code attempt",
            async (code, description) => {
                h.sessions.getByAuthorizationCode.mockResolvedValue(
                    withTxCode(),
                );
                h.oauth.verifyPreAuthorizedCodeAccessTokenRequest.mockRejectedValue(
                    libraryError(code, description),
                );
                expect(await token(preAuth("9999"))).toEqual(
                    tokenError(code, description),
                );
                expect(
                    h.recordFailedTxCodeAttempt.execute,
                ).not.toHaveBeenCalled();
            },
        );

        it("does not count invalid_grant when no tx_code is expected", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(session());
            h.oauth.verifyPreAuthorizedCodeAccessTokenRequest.mockRejectedValue(
                libraryError(
                    "invalid_grant",
                    "Invalid 'pre-authorized_code' provided",
                ),
            );
            expect(await token(preAuth())).toEqual(
                tokenError(
                    "invalid_grant",
                    "Invalid 'pre-authorized_code' provided",
                ),
            );
            expect(h.recordFailedTxCodeAttempt.execute).not.toHaveBeenCalled();
        });
    });

    describe("library verification errors", () => {
        it("maps authorization code errors from errorResponse", async () => {
            h.oauth.verifyAuthorizationCodeAccessTokenRequest.mockRejectedValue(
                {
                    errorResponse: {
                        error: "invalid_dpop_proof",
                        error_description: "DPoP jkt mismatch\nsecond line",
                    },
                },
            );
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(
                tokenError(
                    "invalid_dpop_proof",
                    "DPoP jkt mismatch second line",
                ),
            );
        });

        it("falls back to the cause message", async () => {
            h.oauth.verifyAuthorizationCodeAccessTokenRequest.mockRejectedValue(
                { cause: { message: "inner" } },
            );
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(tokenError("invalid_request", "inner"));
        });

        it("omits the description when nothing is known", async () => {
            h.oauth.verifyAuthorizationCodeAccessTokenRequest.mockRejectedValue(
                {},
            );
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(tokenError("invalid_request"));
        });

        it("maps refresh token errors", async () => {
            h.sessions.getByRefreshToken.mockResolvedValue(session());
            h.oauth.verifyRefreshTokenAccessTokenRequest.mockRejectedValue({
                errorResponse: {
                    error: "invalid_grant",
                    error_description: "Refresh token expired",
                },
            });
            expect(
                await token({
                    grant_type: "refresh_token",
                    refresh_token: "rt",
                }),
            ).toEqual(tokenError("invalid_grant", "Refresh token expired"));
        });

        it("hides access token creation failures", async () => {
            h.oauth.createAccessTokenResponse.mockRejectedValue(
                new Error("kms down"),
            );
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(
                tokenError(
                    "invalid_request",
                    "Failed to create access token response",
                ),
            );
            expect(h.sessions.updateIfUnconsumed).not.toHaveBeenCalled();
        });
    });

    describe("concurrent redemption", () => {
        it("rejects the request that loses the atomic single-use update", async () => {
            h.sessions.updateIfUnconsumed.mockResolvedValue(false);
            expect(
                await token({ grant_type: "authorization_code", code: "c" }),
            ).toEqual(
                tokenError(
                    "invalid_grant",
                    "The credential offer has already been used",
                ),
            );
        });
    });

    describe("successful exchange", () => {
        it("issues a token for the authorization code grant and consumes the session", async () => {
            h.sessions.getByAuthorizationCode.mockResolvedValue(
                session({
                    authorization_code_expires_at: new Date(1000),
                    dpop_jkt: "par-jkt",
                    auth_queries: {
                        client_id: "wallet-client",
                        authorization_details: JSON.stringify([
                            {
                                type: "openid_credential",
                                credential_configuration_id: "pid",
                            },
                            { type: "other", credential_configuration_id: "x" },
                        ]),
                    },
                }),
            );
            const before = Date.now();
            const result = await token(
                {
                    grant_type: "authorization_code",
                    code: "c",
                    client_id: "wallet-client",
                },
                {
                    "oauth-client-attestation": ATTESTATION,
                    "oauth-client-attestation-pop": ATTESTATION_POP,
                },
            );
            expect(result).toEqual({
                value: {
                    access_token: "access-token",
                    token_type: "DPoP",
                    expires_in: 300,
                    refresh_token: "refresh-token",
                },
            });
            expect(
                h.oauth.verifyAuthorizationCodeAccessTokenRequest,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    expectedCode: "code-1",
                    codeExpiresAt: new Date(1000),
                    dpop: {
                        required: false,
                        allowedSigningAlgs: ["ES256", "ES384", "ES512"],
                        jwt: undefined,
                        expectedJwkThumbprint: "par-jkt",
                        maxProofAgeSeconds: 300,
                        allowedClockSkewSeconds: 60,
                    },
                }),
            );
            const authorizationDetails = [
                {
                    type: "openid_credential",
                    credential_configuration_id: "pid",
                    credential_identifiers: ["pid"],
                },
            ];
            expect(h.oauth.createAccessTokenResponse).toHaveBeenCalledWith({
                audience: ISSUER,
                signer: {
                    method: "jwk",
                    alg: "ES256",
                    publicJwk: { kty: "EC", kid: "kid-1" },
                    kid: "kid-1",
                },
                subject: "session-1",
                expiresInSeconds: 300,
                authorizationServer: ISSUER,
                clientId: "wallet-client",
                dpop: { jwkThumbprint: "dpop-jkt" },
                refreshToken: true,
                additionalAccessTokenPayload: {
                    authorization_details: authorizationDetails,
                },
                additionalAccessTokenResponsePayload: {
                    authorization_details: authorizationDetails,
                },
            });
            const [tenant, id, update] =
                h.sessions.updateIfUnconsumed.mock.calls[0];
            expect([tenant, id]).toEqual([TENANT, "session-1"]);
            expect(update).toEqual({
                consumed: true,
                dpop_jkt: "dpop-jkt",
                client_key_jkt: await calculateJwkThumbprint(
                    CLIENT_KEY,
                    "sha256",
                ),
                refresh_token: "refresh-token",
                refresh_token_expires_at: expect.any(Date),
            });
            expect(
                update.refresh_token_expires_at.getTime() - before,
            ).toBeGreaterThanOrEqual(2592000 * 1000 - 5);
        });

        it("derives authorization_details from the offer and honors the refresh config", async () => {
            h = createHarness({
                signingKeyId: "pinned",
                authorizationServers: [
                    {
                        type: "built-in",
                        token: { refreshTokenEnabled: false },
                    },
                ],
            });
            h.sessions.getByAuthorizationCode.mockResolvedValue(
                session({
                    credentialPayload: {
                        credentialConfigurationIds: ["a", 1, "b"],
                    } as never,
                }),
            );
            h.oauth.createAccessTokenResponse.mockResolvedValue({
                access_token: "at",
            });
            await token({
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                "pre-authorized_code": "code-1",
            });
            expect(h.keyChain.getKid).not.toHaveBeenCalled();
            expect(h.keyChain.getPublicKey).toHaveBeenCalledWith(
                "jwk",
                TENANT,
                "pinned",
            );
            expect(h.oauth.createAccessTokenResponse).toHaveBeenCalledWith(
                expect.objectContaining({
                    refreshToken: false,
                    clientId: undefined,
                    dpop: undefined,
                    additionalAccessTokenPayload: {
                        authorization_details: [
                            {
                                type: "openid_credential",
                                credential_configuration_id: "a",
                                credential_identifiers: ["a"],
                            },
                            {
                                type: "openid_credential",
                                credential_configuration_id: "b",
                                credential_identifiers: ["b"],
                            },
                        ],
                    },
                }),
            );
            expect(h.sessions.updateIfUnconsumed).toHaveBeenCalledWith(
                TENANT,
                "session-1",
                {
                    consumed: true,
                    dpop_jkt: undefined,
                    client_key_jkt: undefined,
                },
            );
        });

        it("refreshes without rotation and keeps DPoP binding for public clients", async () => {
            h.sessions.getByRefreshToken.mockResolvedValue(
                session({
                    refresh_token: "rt",
                    refresh_token_expires_at: new Date(5000),
                    dpop_jkt: "bound-jkt",
                }),
            );
            await token({ grant_type: "refresh_token", refresh_token: "rt" });
            expect(
                h.oauth.verifyRefreshTokenAccessTokenRequest,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    expectedRefreshToken: "rt",
                    refreshTokenExpiresAt: new Date(5000),
                    dpop: expect.objectContaining({
                        required: true,
                        expectedJwkThumbprint: "bound-jkt",
                    }),
                }),
            );
            expect(h.oauth.createAccessTokenResponse).toHaveBeenCalledWith(
                expect.objectContaining({
                    refreshToken: false,
                    additionalAccessTokenPayload: undefined,
                    additionalAccessTokenResponsePayload: undefined,
                }),
            );
            expect(h.sessions.updateIfUnconsumed).not.toHaveBeenCalled();
        });

        it("lets attested clients refresh with a new DPoP key", async () => {
            h.sessions.getByRefreshToken.mockResolvedValue(
                session({ refresh_token: "rt", dpop_jkt: "bound-jkt" }),
            );
            await token(
                { grant_type: "refresh_token", refresh_token: "rt" },
                {
                    "oauth-client-attestation": ATTESTATION,
                    "oauth-client-attestation-pop": ATTESTATION_POP,
                },
            );
            expect(
                h.oauth.verifyRefreshTokenAccessTokenRequest,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    dpop: expect.objectContaining({
                        required: true,
                        expectedJwkThumbprint: undefined,
                    }),
                }),
            );
        });
    });
});

describe("Built-in authorization server PAR endpoint", () => {
    let h: Harness;
    const validPar = {
        response_type: "code",
        client_id: "wallet-client",
        redirect_uri: "https://wallet.example/cb",
        code_challenge: "challenge",
        code_challenge_method: "S256",
    };
    const par = (body: Record<string, unknown>, headers = {}) =>
        outcome(
            h.service.handlePar(
                TENANT,
                body as never,
                request(headers, "/issuers/tenant-1/authorize/par"),
            ),
        );

    beforeEach(() => {
        h = createHarness();
    });

    it("rejects failed client attestation with a generic 400 invalid_client", async () => {
        h.walletAttestation.verifyWalletAttestation.mockRejectedValue(
            new Error("secret detail"),
        );
        expect(await par(validPar)).toEqual(
            tokenError(
                "invalid_client",
                "Client attestation validation failed",
            ),
        );
    });

    it.each([
        [
            { request_uri: "urn:x" },
            "invalid_request",
            "The request_uri parameter must not be sent to the PAR endpoint",
        ],
        [
            { response_type: "token" },
            "unsupported_response_type",
            "Only response_type 'code' is supported",
        ],
        [
            { client_id: undefined },
            "invalid_request",
            "Missing required parameter: client_id",
        ],
        [
            { redirect_uri: undefined },
            "invalid_request",
            "Missing required parameter: redirect_uri",
        ],
        [
            { code_challenge: undefined },
            "invalid_request",
            "Missing required parameter: code_challenge",
        ],
        [
            { code_challenge_method: "plain" },
            "invalid_request",
            "Only code_challenge_method 'S256' is supported",
        ],
    ])("rejects %o", async (override, error, description) => {
        expect(await par({ ...validPar, ...override })).toEqual(
            tokenError(error, description),
        );
        expect(h.oauth.verifyPushedAuthorizationRequest).not.toHaveBeenCalled();
    });

    it("maps library errors", async () => {
        h.oauth.verifyPushedAuthorizationRequest.mockRejectedValue({
            errorResponse: {
                error: "invalid_dpop_proof",
                error_description: "bad proof",
            },
        });
        expect(await par(validPar)).toEqual(
            tokenError("invalid_dpop_proof", "bad proof"),
        );
    });

    it("verifies DPoP optionally with the requested thumbprint", async () => {
        await par({ ...validPar, dpop_jkt: "jkt" }, { dpop: "proof" });
        expect(h.oauth.verifyPushedAuthorizationRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                request: expect.objectContaining({
                    url: `${PUBLIC_URL}/issuers/tenant-1/authorize/par`,
                }),
                dpop: {
                    required: false,
                    jwt: "proof",
                    jwkThumbprint: "jkt",
                    allowedSigningAlgs: ["ES256", "ES384", "ES512"],
                    maxProofAgeSeconds: 300,
                    allowedClockSkewSeconds: 60,
                },
            }),
        );
    });

    it("binds the request to an existing issuer_state session", async () => {
        const result = await par({ ...validPar, issuer_state: "offer-1" });
        expect(result).toEqual({
            value: {
                expires_in: 60,
                request_uri: expect.stringMatching(
                    /^urn:ietf:params:oauth:request_uri:/,
                ),
            },
        });
        expect(h.sessions.updateForTenant).toHaveBeenCalledWith(
            TENANT,
            "offer-1",
            expect.objectContaining({
                request_uri: (result as { value: { request_uri: string } })
                    .value.request_uri,
                request_uri_expires_at: expect.any(Date),
                dpop_jkt: "par-jkt",
            }),
        );
        expect(h.createSession.execute).not.toHaveBeenCalled();
    });

    it("creates a session when issuer_state is unknown or absent", async () => {
        h.sessions.updateForTenant.mockResolvedValue(false);
        await par({ ...validPar, issuer_state: "unknown" });
        await par(validPar);
        expect(h.createSession.execute).toHaveBeenCalledTimes(2);
        expect(h.createSession.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: TENANT,
                auth_queries: validPar,
                dpop_jkt: "par-jkt",
            }),
        );
    });
});

describe("Built-in authorization server authorize endpoint", () => {
    let h: Harness;
    const parSession = (overrides: Partial<SessionData> = {}) =>
        session({
            request_uri: "urn:r",
            request_uri_expires_at: new Date(Date.now() + 60_000),
            auth_queries: {
                client_id: "wallet-client",
                redirect_uri: "https://wallet.example/cb?keep=1",
                state: "wallet-state",
            },
            ...overrides,
        });

    beforeEach(() => {
        h = createHarness();
    });

    it("rejects a missing request_uri with 409", async () => {
        expect(
            await outcome(h.service.sendAuthorizationResponse({}, TENANT)),
        ).toEqual({
            status: 409,
            body: {
                statusCode: 409,
                error: "Conflict",
                message: "request_uri not found or not provided in the request",
            },
        });
    });

    it("rejects an unknown request_uri", async () => {
        h.sessions.getByRequestUri.mockRejectedValue(new Error("nope"));
        expect(
            await outcome(
                h.service.sendAuthorizationResponse(
                    { request_uri: "urn:r" },
                    TENANT,
                ),
            ),
        ).toEqual(tokenError("invalid_request_uri", "Unknown request_uri"));
    });

    it("rejects a request_uri without redirect_uri", async () => {
        h.sessions.getByRequestUri.mockResolvedValue(
            parSession({ auth_queries: {} }),
        );
        expect(
            await outcome(
                h.service.sendAuthorizationResponse(
                    { request_uri: "urn:r" },
                    TENANT,
                ),
            ),
        ).toEqual(
            tokenError(
                "invalid_request_uri",
                "request_uri has no redirect_uri bound",
            ),
        );
    });

    it("redirects with an error on client_id mismatch", async () => {
        h.sessions.getByRequestUri.mockResolvedValue(parSession());
        const url = await h.service.sendAuthorizationResponse(
            { request_uri: "urn:r", client_id: "other" },
            TENANT,
        );
        expect(url).toBe(
            "https://wallet.example/cb?keep=1&error=invalid_request&error_description=client_id+does+not+match+the+pushed+authorization+request&state=wallet-state&iss=https%3A%2F%2Fissuer.example%2Fissuers%2Ftenant-1",
        );
        expect(h.sessions.updateForTenant).not.toHaveBeenCalled();
    });

    it("redirects with an error when the request_uri expired", async () => {
        h.sessions.getByRequestUri.mockResolvedValue(
            parSession({ request_uri_expires_at: new Date(Date.now() - 1) }),
        );
        const url = await h.service.sendAuthorizationResponse(
            { request_uri: "urn:r", client_id: "wallet-client" },
            TENANT,
        );
        expect(new URL(url).searchParams.get("error")).toBe(
            "invalid_request_uri",
        );
        expect(new URL(url).searchParams.get("error_description")).toBe(
            "request_uri is expired or was already used",
        );
    });

    it("expires the request_uri and redirects with a fresh code", async () => {
        h.sessions.getByRequestUri.mockResolvedValue(parSession());
        const url = new URL(
            await h.service.sendAuthorizationResponse(
                { request_uri: "urn:r", client_id: "wallet-client" },
                TENANT,
            ),
        );
        const code = url.searchParams.get("code");
        expect(code).toMatch(/^[0-9a-f-]{36}$/);
        expect(url.searchParams.get("keep")).toBe("1");
        expect(url.searchParams.get("state")).toBe("wallet-state");
        expect(url.searchParams.get("iss")).toBe(ISSUER);
        expect(h.sessions.updateForTenant).toHaveBeenNthCalledWith(
            1,
            TENANT,
            "session-1",
            { request_uri_expires_at: expect.any(Date) },
        );
        expect(h.sessions.updateForTenant).toHaveBeenNthCalledWith(
            2,
            TENANT,
            "session-1",
            {
                authorization_code: code,
                authorization_code_expires_at: expect.any(Date),
            },
        );
    });
});

describe("Built-in authorization server metadata and challenge", () => {
    it("advertises the built-in authorization server", async () => {
        const h = createHarness({ walletAttestationRequired: true });
        const metadata = await h.service.authzMetadata(TENANT);
        expect(metadata).toMatchObject({
            issuer: ISSUER,
            token_endpoint: `${ISSUER}/authorize/token`,
            pushed_authorization_request_endpoint: `${ISSUER}/authorize/par`,
            jwks_uri: `${PUBLIC_URL}/.well-known/jwks.json/issuers/${TENANT}`,
            grant_types_supported: [
                "authorization_code",
                "refresh_token",
                "urn:ietf:params:oauth:grant-type:pre-authorized_code",
            ],
            token_endpoint_auth_methods_supported: [
                "attest_jwt_client_auth",
                "none",
            ],
            require_pushed_authorization_requests: true,
            status_list_aggregation_endpoint: undefined,
        });
    });

    it("stores a challenge nonce for ten minutes", async () => {
        const h = createHarness();
        const { attestation_challenge } =
            await h.service.challengeRequest(TENANT);
        expect(h.nonces.save).toHaveBeenCalledWith({
            nonce: attestation_challenge,
            tenantId: TENANT,
            expiresAt: expect.any(Date),
        });
    });
});
