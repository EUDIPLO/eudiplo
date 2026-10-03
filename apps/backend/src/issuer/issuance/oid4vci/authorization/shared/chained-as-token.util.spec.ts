import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type ChainedAsSession,
    ChainedAsSessionStatus,
} from "../domain/chained-as-session.js";
import { refreshTokenPolicy } from "../domain/token-grant-rules.js";
import {
    issueRefreshTokenIfEnabled,
    resolveSessionForTokenRequest,
    retainSessionForIssuedTokens,
} from "./chained-as-token.util.js";
import type { ChainedAsTokenRequestDto } from "./dto/chained-as.dto.js";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function chainedSession(
    overrides: Partial<ChainedAsSession> = {},
): ChainedAsSession {
    return {
        id: "session-1",
        tenantId: "tenant-1",
        status: ChainedAsSessionStatus.TOKEN_ISSUED,
        issuerState: "issuer-state",
        clientId: "wallet",
        redirectUri: "https://wallet.example/cb",
        createdAt: new Date(NOW.getTime() - DAY_MS),
        updatedAt: new Date(NOW.getTime() - DAY_MS),
        expiresAt: new Date(NOW.getTime() - DAY_MS + 600_000),
        ...overrides,
    };
}

describe("issueRefreshTokenIfEnabled", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("issues a refresh token valid for 30 days without token settings", () => {
        const session = chainedSession();

        const refreshToken = issueRefreshTokenIfEnabled(
            session,
            undefined,
            "authorization_code",
        );

        expect(refreshToken).toBeDefined();
        expect(session.refreshToken).toBe(refreshToken);
        expect(session.refreshTokenExpiresAt).toEqual(
            new Date(NOW.getTime() + 30 * DAY_MS),
        );
    });

    it("uses the configured lifetime", () => {
        const session = chainedSession();

        issueRefreshTokenIfEnabled(
            session,
            { refreshTokenExpiresInSeconds: 120 },
            "authorization_code",
        );

        expect(session.refreshTokenExpiresAt).toEqual(
            new Date(NOW.getTime() + 120_000),
        );
    });

    it("issues nothing when refresh tokens are disabled", () => {
        const session = chainedSession();

        expect(
            issueRefreshTokenIfEnabled(
                session,
                { refreshTokenEnabled: false },
                "authorization_code",
            ),
        ).toBeUndefined();
        expect(session.refreshToken).toBeUndefined();
        expect(session.refreshTokenExpiresAt).toBeUndefined();
    });

    it("keeps the expiry of the redeemed token when rotating", () => {
        const expiresAt = new Date(NOW.getTime() + DAY_MS);
        const session = chainedSession({
            refreshToken: "old",
            refreshTokenExpiresAt: expiresAt,
        });

        const refreshToken = issueRefreshTokenIfEnabled(
            session,
            undefined,
            "refresh_token",
        );

        expect(refreshToken).not.toBe("old");
        expect(session.refreshTokenExpiresAt).toBe(expiresAt);
    });

    it("bounds a rotated token stored without an expiry by the session creation", () => {
        const session = chainedSession({ refreshToken: "old" });

        issueRefreshTokenIfEnabled(session, undefined, "refresh_token");

        expect(session.refreshTokenExpiresAt).toEqual(
            new Date(session.createdAt.getTime() + 30 * DAY_MS),
        );
    });
});

describe("resolveSessionForTokenRequest with refresh_token", () => {
    const request = {
        grant_type: "refresh_token",
        refresh_token: "refresh",
    } as ChainedAsTokenRequestDto;

    const repository = (session: ChainedAsSession | null) => ({
        findByRefreshToken: vi.fn().mockResolvedValue(session),
        findAuthorizedByCode: vi.fn(),
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns the session of a valid refresh token", async () => {
        const session = chainedSession({
            refreshToken: "refresh",
            refreshTokenExpiresAt: new Date(NOW.getTime() + DAY_MS),
        });

        await expect(
            resolveSessionForTokenRequest(
                repository(session),
                "tenant-1",
                request,
                refreshTokenPolicy(undefined),
            ),
        ).resolves.toBe(session);
    });

    it("rejects the grant when refresh tokens are disabled", async () => {
        const sessions = repository(chainedSession());

        const result = resolveSessionForTokenRequest(
            sessions,
            "tenant-1",
            request,
            refreshTokenPolicy({ refreshTokenEnabled: false }),
        );

        await expect(result).rejects.toBeInstanceOf(BadRequestException);
        await expect(result).rejects.toMatchObject({
            response: { error: "unsupported_grant_type" },
        });
        expect(sessions.findByRefreshToken).not.toHaveBeenCalled();
    });

    it("rejects an expired refresh token", async () => {
        const session = chainedSession({
            refreshToken: "refresh",
            refreshTokenExpiresAt: new Date(NOW.getTime() - 1),
        });

        await expect(
            resolveSessionForTokenRequest(
                repository(session),
                "tenant-1",
                request,
                refreshTokenPolicy(undefined),
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("expires a refresh token stored without an expiry", async () => {
        const session = chainedSession({
            refreshToken: "refresh",
            createdAt: new Date(NOW.getTime() - 31 * DAY_MS),
        });

        await expect(
            resolveSessionForTokenRequest(
                repository(session),
                "tenant-1",
                request,
                refreshTokenPolicy(undefined),
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });
});

describe("retainSessionForIssuedTokens", () => {
    it("keeps the session until the last issued token expires", () => {
        const accessTokenExpiresAt = new Date(NOW.getTime() + 3600_000);
        const session = chainedSession();

        retainSessionForIssuedTokens(session, accessTokenExpiresAt);
        expect(session.expiresAt).toEqual(accessTokenExpiresAt);

        const refreshTokenExpiresAt = new Date(NOW.getTime() + 30 * DAY_MS);
        session.refreshTokenExpiresAt = refreshTokenExpiresAt;
        retainSessionForIssuedTokens(session, accessTokenExpiresAt);
        expect(session.expiresAt).toEqual(refreshTokenExpiresAt);
    });

    it("never shortens the session", () => {
        const expiresAt = new Date(NOW.getTime() + DAY_MS);
        const session = chainedSession({ expiresAt });

        retainSessionForIssuedTokens(session, NOW);

        expect(session.expiresAt).toEqual(expiresAt);
    });
});
