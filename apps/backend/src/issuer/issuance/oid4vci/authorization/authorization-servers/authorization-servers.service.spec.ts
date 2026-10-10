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
        getKid: vi.fn().mockResolvedValue("default-key"),
        getPublicKey: vi.fn().mockResolvedValue({ kty: "EC" }),
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
    return { authorizationServers, sessionRepository };
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
