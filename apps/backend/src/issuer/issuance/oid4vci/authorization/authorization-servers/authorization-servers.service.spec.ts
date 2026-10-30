import { BadRequestException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type ChainedAsSession,
    ChainedAsSessionStatus,
} from "../domain/chained-as-session.js";
import { hashRefreshToken } from "../domain/token-grant-rules.js";
import type { ChainedAsTokenRequestDto } from "../shared/dto/chained-as.dto.js";
import { AuthorizationServersService } from "./authorization-servers.service.js";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function authorizedSession(): ChainedAsSession {
    return {
        id: "session-1",
        tenantId: "tenant-1",
        status: ChainedAsSessionStatus.AUTHORIZED,
        issuerState: "issuer-state",
        clientId: "wallet",
        redirectUri: "https://wallet.example/cb",
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: "S256",
        authorizationCode: "code",
        authorizationCodeExpiresAt: new Date(NOW.getTime() + 60_000),
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 600_000),
    };
}

/** OID4VP authorization server `pid-auth` with the given `token` settings. */
function service(
    token: Record<string, unknown> | undefined,
    session: ChainedAsSession,
) {
    const sessionRepository = {
        findAuthorizedByCode: vi.fn().mockResolvedValue(session),
        findByRefreshToken: vi.fn().mockResolvedValue(session),
        save: vi.fn(async (saved: ChainedAsSession) => saved),
    };
    const issuanceService = {
        getIssuanceConfiguration: vi.fn().mockResolvedValue({
            authorizationServers: [
                {
                    type: "oid4vp",
                    id: "pid-auth",
                    presentationConfigId: "pid",
                    token,
                },
            ],
        }),
    };
    const keyChainService = {
        resolveAccessTokenKeyChain: vi.fn(
            async (_tenantId: string, keyId?: string) => ({
                id: keyId ?? "access-token",
            }),
        ),
        getAccessTokenVerificationKeys: vi
            .fn()
            .mockResolvedValue([{ kty: "EC", kid: "access-token-1" }]),
        signJWT: vi.fn().mockResolvedValue("access-token"),
    };
    const walletAttestationService = {
        verifyWalletAttestation: vi.fn().mockResolvedValue(undefined),
    };
    const authorizationServers = new AuthorizationServersService(
        { publicUrl: "https://issuer.example" } as any,
        keyChainService as any,
        {} as any,
        {} as any,
        issuanceService as any,
        walletAttestationService as any,
        {} as any,
        {} as any,
        sessionRepository as any,
        { getCallbackContext: vi.fn().mockReturnValue({}) } as any,
        { register: vi.fn().mockResolvedValue(true) },
    );
    return { authorizationServers, sessionRepository, keyChainService };
}

const codeRequest = {
    grant_type: "authorization_code",
    code: "code",
    code_verifier: CODE_VERIFIER,
} as ChainedAsTokenRequestDto;

describe("AuthorizationServersService refresh tokens", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("issues refresh tokens valid for 30 days without token settings", async () => {
        const session = authorizedSession();
        const { authorizationServers } = service(undefined, session);

        const response = await authorizationServers.handleToken(
            "tenant-1",
            "pid-auth",
            codeRequest,
        );

        expect(response.refresh_token).toBeDefined();
        expect(session.refreshToken).toBe(
            hashRefreshToken(response.refresh_token!),
        );
        expect(session.refreshTokenExpiresAt).toEqual(
            new Date(NOW.getTime() + 30 * DAY_MS),
        );
        // Cleanup keeps the session as long as the refresh token is valid.
        expect(session.expiresAt).toEqual(session.refreshTokenExpiresAt);
    });

    it("issues no refresh token and rejects the grant when disabled", async () => {
        const session = authorizedSession();
        const { authorizationServers, sessionRepository } = service(
            { refreshTokenEnabled: false },
            session,
        );

        const response = await authorizationServers.handleToken(
            "tenant-1",
            "pid-auth",
            codeRequest,
        );
        expect(response.refresh_token).toBeUndefined();
        // ...and as long as the access token is valid (default one hour).
        expect(session.expiresAt).toEqual(new Date(NOW.getTime() + 3600_000));

        await expect(
            authorizationServers.handleToken("tenant-1", "pid-auth", {
                grant_type: "refresh_token",
                refresh_token: "refresh",
            } as ChainedAsTokenRequestDto),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(sessionRepository.findByRefreshToken).not.toHaveBeenCalled();
    });

    it("advertises the refresh_token grant only when enabled", async () => {
        const session = authorizedSession();

        await expect(
            service(undefined, session).authorizationServers.getMetadata(
                "tenant-1",
                "pid-auth",
            ),
        ).resolves.toMatchObject({
            grant_types_supported: ["authorization_code", "refresh_token"],
        });
        await expect(
            service(
                { refreshTokenEnabled: false },
                session,
            ).authorizationServers.getMetadata("tenant-1", "pid-auth"),
        ).resolves.toMatchObject({
            grant_types_supported: ["authorization_code"],
        });
    });
});

describe("AuthorizationServersService access token key", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("signs with the tenant's access token key chain without token.signingKeyId", async () => {
        const { authorizationServers, keyChainService } = service(
            undefined,
            authorizedSession(),
        );

        await authorizationServers.handleToken(
            "tenant-1",
            "pid-auth",
            codeRequest,
        );

        expect(keyChainService.resolveAccessTokenKeyChain).toHaveBeenCalledWith(
            "tenant-1",
            undefined,
        );
        expect(keyChainService.signJWT).toHaveBeenCalledWith(
            expect.anything(),
            { typ: "at+jwt" },
            "tenant-1",
            "access-token",
        );
    });

    it("signs with the named key chain and publishes it for the token lifetime", async () => {
        const { authorizationServers, keyChainService } = service(
            { signingKeyId: "as-key", lifetimeSeconds: 900 },
            authorizedSession(),
        );

        await authorizationServers.handleToken(
            "tenant-1",
            "pid-auth",
            codeRequest,
        );
        await expect(
            authorizationServers.getJwks("tenant-1", "pid-auth"),
        ).resolves.toEqual({ keys: [{ kty: "EC", kid: "access-token-1" }] });

        expect(keyChainService.signJWT).toHaveBeenCalledWith(
            expect.anything(),
            { typ: "at+jwt" },
            "tenant-1",
            "as-key",
        );
        expect(
            keyChainService.getAccessTokenVerificationKeys,
        ).toHaveBeenCalledWith("tenant-1", "as-key", 900);
    });
});

describe("AuthorizationServersService OID4VP callback", () => {
    /** A pending callback whose verifier session is in the given state. */
    function callback(verifierSession: Record<string, unknown>) {
        const session = {
            ...authorizedSession(),
            status: ChainedAsSessionStatus.PENDING_VP_CALLBACK,
            authorizationCode: undefined,
            authorizationCodeExpiresAt: undefined,
            walletState: "wallet-state",
        };
        const sessionRepository = {
            findForTenant: vi.fn().mockResolvedValue(session),
            save: vi.fn(async (saved: ChainedAsSession) => saved),
        };
        const sessionStore = {
            getForTenant: vi.fn().mockResolvedValue({
                id: "session-1",
                ...verifierSession,
            }),
            updateForTenant: vi.fn(),
        };
        const authorizationServers = new AuthorizationServersService(
            { publicUrl: "https://issuer.example" } as any,
            {} as any,
            {} as any,
            sessionStore as any,
            {
                getIssuanceConfiguration: vi.fn().mockResolvedValue({
                    authorizationServers: [
                        {
                            type: "oid4vp",
                            id: "pid-auth",
                            presentationConfigId: "pid",
                        },
                    ],
                }),
            } as any,
            {} as any,
            {} as any,
            {} as any,
            sessionRepository as any,
            {} as any,
            { register: vi.fn().mockResolvedValue(true) },
        );
        const call = (
            responseCode?: string,
            error?: string,
            errorDescription?: string,
        ) =>
            authorizationServers.handleVerifierCallback(
                "tenant-1",
                "pid-auth",
                "session-1",
                responseCode,
                error,
                errorDescription,
            );
        return { call, session, sessionRepository };
    }

    it.each([
        ["without a response_code", "completed", undefined, undefined],
        ["with a wrong response_code", "completed", "guess", undefined],
        [
            "with an error while the presentation is open",
            "active",
            undefined,
            "access_denied",
        ],
        [
            "before the presentation ended",
            "fetched",
            "response-code",
            undefined,
        ],
    ])(
        "keeps the authorization pending for a call %s",
        async (_case, status, responseCode, error) => {
            const { call, session, sessionRepository } = callback({
                status,
                responseCode: "response-code",
            });

            await expect(call(responseCode, error)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(session.status).toBe(
                ChainedAsSessionStatus.PENDING_VP_CALLBACK,
            );
            expect(sessionRepository.save).not.toHaveBeenCalled();
        },
    );

    it("ends the authorization with the wallet's error once the presentation failed", async () => {
        const { call, session } = callback({ status: "failed" });

        const location = new URL(
            await call(undefined, "access_denied", "user said no"),
        );

        expect(location.searchParams.get("error")).toBe("access_denied");
        expect(location.searchParams.get("error_description")).toBe(
            "user said no",
        );
        expect(location.searchParams.get("state")).toBe("wallet-state");
        expect(session.status).toBe(ChainedAsSessionStatus.EXPIRED);
    });

    it.each(["expired", "cancelled"])(
        "ends the authorization with invalid_request once the presentation is %s",
        async (status) => {
            const { call, session } = callback({ status });

            const location = new URL(await call());

            expect(location.searchParams.get("error")).toBe("invalid_request");
            expect(location.searchParams.get("error_description")).toBe(
                "OID4VP verification did not complete successfully",
            );
            expect(session.status).toBe(ChainedAsSessionStatus.EXPIRED);
        },
    );

    it("issues the code for the verifier session's response_code", async () => {
        const { call, session } = callback({
            status: "completed",
            responseCode: "response-code",
        });

        // An error parameter does not override the verified presentation.
        const location = new URL(await call("response-code", "access_denied"));

        expect(location.searchParams.get("code")).toEqual(expect.any(String));
        expect(session.status).toBe(ChainedAsSessionStatus.AUTHORIZED);
    });
});
