import { randomBytes } from "node:crypto";
import {
    type GenerateRandomCallback,
    type Jwk,
    Oauth2AuthorizationServer,
    preAuthorizedCodeGrantIdentifier,
    refreshTokenGrantIdentifier,
    type SignJwtCallback,
} from "@openid4vc/oauth2";
import {
    CompactSign,
    decodeProtectedHeader,
    exportJWK,
    generateKeyPair,
    jwtVerify,
} from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../../session/domain/session-data.js";
import type { Oid4vciSettings } from "../../oid4vci-settings.js";
import {
    hashAuthorizationCode,
    hashRefreshToken,
} from "../domain/token-grant-rules.js";
import { ExchangeAccessToken } from "./exchange-access-token.js";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUER = "https://issuer.example/issuers/tenant-1";

const preAuthorizedCodeRequest = {
    grant: {
        grantType: preAuthorizedCodeGrantIdentifier,
        preAuthorizedCode: "code",
    },
    accessTokenRequest: {
        grant_type: preAuthorizedCodeGrantIdentifier,
        "pre-authorized_code": "code",
    },
};

const refreshTokenRequest = {
    grant: { grantType: refreshTokenGrantIdentifier, refreshToken: "refresh" },
    accessTokenRequest: {
        grant_type: refreshTokenGrantIdentifier,
        refresh_token: "refresh",
    },
};

function issuanceSession(overrides: Partial<SessionData> = {}): SessionData {
    return {
        id: "session-1",
        tenantId: "tenant-1",
        createdAt: new Date(NOW.getTime() - DAY_MS),
        authorization_code: hashAuthorizationCode("code"),
        credentialPayload: { flow: "pre_authorized_code" },
        ...overrides,
    } as SessionData;
}

/** Built-in token endpoint with fake ports. */
function exchange(
    issuanceConfig: Record<string, unknown>,
    parsed: object,
    session: SessionData,
    options: {
        publicJwk?: Jwk;
        createAccessTokenResponse?: Oauth2AuthorizationServer["createAccessTokenResponse"];
    } = {},
) {
    const server = {
        parseAccessTokenRequest: vi.fn().mockReturnValue(parsed),
        verifyPreAuthorizedCodeAccessTokenRequest: vi
            .fn()
            .mockResolvedValue({}),
        verifyRefreshTokenAccessTokenRequest: vi.fn().mockResolvedValue({}),
        createAccessTokenResponse: vi.fn(
            options.createAccessTokenResponse ??
                (async (options) => ({
                    access_token: "access-token",
                    token_type: "Bearer",
                    expires_in: options.expiresInSeconds,
                    ...(options.refreshToken
                        ? { refresh_token: "new-refresh" }
                        : {}),
                })),
        ),
    };
    const sessions = {
        getByAuthorizationCode: vi.fn().mockResolvedValue(session),
        getByRefreshToken: vi.fn().mockResolvedValue(session),
        updateForTenant: vi.fn(),
        updateIfUnconsumed: vi.fn().mockResolvedValue(true),
    };
    const signingKeys = {
        resolve: vi.fn(async (_tenantId: string, keyId?: string) => ({
            keyId: keyId ?? "access-token",
            publicJwk:
                options.publicJwk ?? ({ kty: "EC", crv: "P-256" } as Jwk),
        })),
    };
    const useCase = new ExchangeAccessToken(
        {
            forTenant: () => server as unknown as Oauth2AuthorizationServer,
        },
        sessions as any,
        { execute: vi.fn() },
        {
            issuanceConfiguration: vi.fn().mockResolvedValue(issuanceConfig),
            statusListAggregationEnabled: vi.fn().mockResolvedValue(false),
            sessionTtlSeconds: vi.fn().mockResolvedValue(3600),
        } as any,
        {
            execute: vi.fn().mockResolvedValue({
                issuer: ISSUER,
                dpop_signing_alg_values_supported: ["ES256"],
            }),
        },
        { verify: vi.fn().mockResolvedValue(undefined) },
        signingKeys,
        { publicUrl: "https://issuer.example" } as Oid4vciSettings,
        { register: vi.fn().mockResolvedValue(true) },
    );
    const execute = () =>
        useCase.execute({
            tenantId: "tenant-1",
            body: {},
            request: {
                url: `${ISSUER}/authorize/token`,
                method: "POST",
                headers: new Headers(),
            },
        });
    return { execute, server, sessions, signingKeys };
}

describe("ExchangeAccessToken", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("issues five minute access tokens with the access token key chain and a 30 day refresh token", async () => {
        const { execute, server, sessions, signingKeys } = exchange(
            { authorizationServers: [{ type: "built-in", id: "built-in" }] },
            preAuthorizedCodeRequest,
            issuanceSession(),
        );

        await execute();

        expect(
            server.verifyPreAuthorizedCodeAccessTokenRequest.mock.calls[0][0]
                .dpop.required,
        ).toBe(false);
        expect(signingKeys.resolve).toHaveBeenCalledWith("tenant-1", undefined);
        expect(server.createAccessTokenResponse).toHaveBeenCalledWith(
            expect.objectContaining({
                expiresInSeconds: 300,
                refreshToken: true,
                signer: expect.objectContaining({ kid: "access-token" }),
            }),
        );
        expect(sessions.updateIfUnconsumed).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
            expect.objectContaining({
                refresh_token: hashRefreshToken("new-refresh"),
                refresh_token_expires_at: new Date(NOW.getTime() + 30 * DAY_MS),
            }),
        );
    });

    it("honors the token settings and requireDPoP of the built-in server", async () => {
        const { execute, server, signingKeys } = exchange(
            {
                authorizationServers: [
                    {
                        type: "built-in",
                        id: "built-in",
                        token: {
                            lifetimeSeconds: 900,
                            signingKeyId: "as-key",
                            refreshTokenEnabled: false,
                        },
                        requireDPoP: true,
                    },
                ],
            },
            preAuthorizedCodeRequest,
            issuanceSession(),
        );

        await execute();

        expect(
            server.verifyPreAuthorizedCodeAccessTokenRequest.mock.calls[0][0]
                .dpop.required,
        ).toBe(true);
        expect(signingKeys.resolve).toHaveBeenCalledWith("tenant-1", "as-key");
        expect(server.createAccessTokenResponse).toHaveBeenCalledWith(
            expect.objectContaining({
                expiresInSeconds: 900,
                refreshToken: false,
                signer: expect.objectContaining({ kid: "as-key" }),
            }),
        );
    });

    it("signs the access token with ES384 when the signing key is on P-384", async () => {
        const { publicKey, privateKey } = await generateKeyPair("ES384");
        const publicJwk = (await exportJWK(publicKey)) as Jwk;
        // A real library server whose JWT signer uses the P-384 private key,
        // so the asserted header is the one the library writes from `signer`.
        const signJwt: SignJwtCallback = async (
            _signer,
            { header, payload },
        ) => ({
            jwt: await new CompactSign(
                new TextEncoder().encode(JSON.stringify(payload)),
            )
                .setProtectedHeader(header)
                .sign(privateKey),
            signerJwk: publicJwk,
        });
        const generateRandom: GenerateRandomCallback = (length) =>
            randomBytes(length);
        const library = new Oauth2AuthorizationServer({
            // Only the callbacks createAccessTokenResponse calls.
            callbacks: { signJwt, generateRandom } as never,
        });
        const { execute, server } = exchange(
            { authorizationServers: [{ type: "built-in", id: "built-in" }] },
            preAuthorizedCodeRequest,
            issuanceSession(),
            {
                publicJwk,
                createAccessTokenResponse: (options) =>
                    library.createAccessTokenResponse(options),
            },
        );

        await execute();

        expect(server.createAccessTokenResponse).toHaveBeenCalledWith(
            expect.objectContaining({
                signer: expect.objectContaining({
                    method: "jwk",
                    alg: "ES384",
                }),
            }),
        );
        const { access_token } =
            await server.createAccessTokenResponse.mock.results[0].value;
        expect(decodeProtectedHeader(access_token).alg).toBe("ES384");
        await expect(
            jwtVerify(access_token, publicKey, { currentDate: NOW }),
        ).resolves.toBeDefined();
    });

    it("rejects refresh grants when refresh tokens are disabled", async () => {
        const { execute, server } = exchange(
            {
                authorizationServers: [
                    {
                        type: "built-in",
                        id: "built-in",
                        token: { refreshTokenEnabled: false },
                    },
                ],
            },
            refreshTokenRequest,
            issuanceSession({ consumed: true, refresh_token: "refresh" }),
        );

        await expect(execute()).rejects.toMatchObject({
            code: "unsupported_grant_type",
        });
        expect(
            server.verifyRefreshTokenAccessTokenRequest,
        ).not.toHaveBeenCalled();
    });

    it("finds the session by the refresh token hash and verifies the presented token", async () => {
        const session = issuanceSession({
            consumed: true,
            refresh_token: hashRefreshToken("refresh"),
        });
        const { execute, server, sessions } = exchange(
            { authorizationServers: [{ type: "built-in", id: "built-in" }] },
            refreshTokenRequest,
            session,
        );

        await execute();

        expect(sessions.getByRefreshToken).toHaveBeenCalledWith(
            "tenant-1",
            hashRefreshToken("refresh"),
        );
        expect(
            server.verifyRefreshTokenAccessTokenRequest.mock.calls[0][0]
                .expectedRefreshToken,
        ).toBe("refresh");
    });

    it("enforces an expiry for refresh tokens stored without one", async () => {
        const session = issuanceSession({
            consumed: true,
            refresh_token: hashRefreshToken("refresh"),
        });
        const { execute, server } = exchange(
            { authorizationServers: [{ type: "built-in", id: "built-in" }] },
            refreshTokenRequest,
            session,
        );

        await execute();

        expect(
            server.verifyRefreshTokenAccessTokenRequest.mock.calls[0][0]
                .refreshTokenExpiresAt,
        ).toEqual(new Date(session.createdAt.getTime() + 30 * DAY_MS));
    });
});
