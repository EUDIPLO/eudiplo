import { randomBytes } from "node:crypto";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import {
    type ChainedAsSession,
    ChainedAsSessionStatus,
} from "../domain/chained-as-session.js";
import {
    type AuthorizationServerTokenSettings,
    enforcedRefreshTokenExpiry,
    type RefreshTokenPolicy,
    refreshTokenExpiresAt,
    refreshTokenPolicy,
} from "../domain/token-grant-rules.js";
import type { ChainedAsSessionRepository } from "../ports/chained-as-session.repository.js";
import { ChainedAsTokenRequestDto } from "./dto/chained-as.dto.js";
import { verifyPkceCodeChallenge } from "./pkce.util.js";

export function buildAuthorizationErrorRedirect(
    redirectUri: string,
    error: string,
    errorDescription?: string,
    walletState?: string,
): string {
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("error", error);
    if (errorDescription) {
        redirectUrl.searchParams.set("error_description", errorDescription);
    }
    if (walletState) {
        redirectUrl.searchParams.set("state", walletState);
    }
    return redirectUrl.toString();
}

export function buildAuthorizationCodeRedirect(
    redirectUri: string,
    authorizationCode: string,
    walletState?: string,
    issuer?: string,
): string {
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", authorizationCode);
    if (issuer) {
        redirectUrl.searchParams.set("iss", issuer);
    }
    if (walletState) {
        redirectUrl.searchParams.set("state", walletState);
    }
    return redirectUrl.toString();
}

export function buildAccessTokenPayload({
    issuer,
    audience,
    session,
    tokenLifetime,
    jti,
    dpopJkt,
}: {
    issuer: string;
    audience: string;
    session: ChainedAsSession;
    tokenLifetime: number;
    jti: string;
    dpopJkt?: string;
}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        iss: issuer,
        sub: session.clientId,
        aud: audience,
        iat: now,
        exp: now + tokenLifetime,
        jti,
        issuer_state: session.issuerState,
        client_id: session.clientId,
    };

    if (dpopJkt) {
        payload.cnf = { jkt: dpopJkt };
    }
    if (
        Array.isArray(session.authorizationDetails) &&
        session.authorizationDetails.length > 0
    ) {
        payload.authorization_details = session.authorizationDetails;
    }

    return payload;
}

export async function resolveSessionForTokenRequest(
    sessionRepository: Pick<
        ChainedAsSessionRepository,
        "findByRefreshToken" | "findAuthorizedByCode"
    >,
    tenantId: string,
    request: ChainedAsTokenRequestDto,
    refreshTokens: RefreshTokenPolicy,
): Promise<ChainedAsSession> {
    if (request.grant_type === "refresh_token") {
        if (!refreshTokens.enabled) {
            const description =
                "Refresh tokens are disabled for this authorization server";
            throw new BadRequestException({
                error: "unsupported_grant_type",
                error_description: description,
                message: description,
            });
        }

        if (!request.refresh_token) {
            throw new BadRequestException(
                "refresh_token is required for refresh_token grant",
            );
        }

        const session = await sessionRepository.findByRefreshToken(
            tenantId,
            request.refresh_token,
        );

        if (!session) {
            throw new UnauthorizedException("Invalid or expired refresh_token");
        }

        // Refresh tokens stored without an expiry still expire.
        if (
            enforcedRefreshTokenExpiry(
                session.refreshTokenExpiresAt,
                session.createdAt,
                refreshTokens,
            ) < new Date()
        ) {
            throw new UnauthorizedException("refresh_token has expired");
        }

        return session;
    }

    if (!request.code) {
        throw new BadRequestException(
            "code is required for authorization_code grant",
        );
    }

    const session = await sessionRepository.findAuthorizedByCode(
        tenantId,
        request.code,
    );

    if (!session) {
        throw new UnauthorizedException("Invalid authorization code");
    }

    return session;
}

export async function assertTokenRequestSessionValid(
    sessionRepository: Pick<ChainedAsSessionRepository, "save">,
    session: ChainedAsSession,
    request: ChainedAsTokenRequestDto,
): Promise<void> {
    if (
        request.grant_type === "authorization_code" &&
        session.authorizationCodeExpiresAt &&
        session.authorizationCodeExpiresAt < new Date()
    ) {
        session.status = ChainedAsSessionStatus.EXPIRED;
        await sessionRepository.save(session);
        throw new UnauthorizedException("Authorization code expired");
    }

    if (request.redirect_uri && request.redirect_uri !== session.redirectUri) {
        throw new BadRequestException("redirect_uri mismatch");
    }

    if (request.grant_type === "authorization_code") {
        verifyPkceCodeChallenge(
            session.codeChallenge,
            session.codeChallengeMethod,
            request.code_verifier,
        );
    }
}

export function resolveTokenBinding(
    requireDPoP: boolean | undefined,
    session: ChainedAsSession,
    dpopJwt?: string,
): { tokenType: string; dpopJkt?: string } {
    if (dpopJwt) {
        return {
            tokenType: "DPoP",
            dpopJkt: session.dpopJkt,
        };
    }

    if (requireDPoP) {
        throw new BadRequestException("DPoP proof is required");
    }

    return { tokenType: "Bearer" };
}

/**
 * Keep the session, which holds the upstream identity and the refresh token,
 * until the tokens issued for it expire. Expired sessions are deleted
 * periodically.
 */
export function retainSessionForIssuedTokens(
    session: ChainedAsSession,
    accessTokenExpiresAt: Date,
): void {
    session.expiresAt = new Date(
        Math.max(
            new Date(session.expiresAt).getTime(),
            accessTokenExpiresAt.getTime(),
            session.refreshTokenExpiresAt
                ? new Date(session.refreshTokenExpiresAt).getTime()
                : 0,
        ),
    );
}

/**
 * Issue a refresh token under the shared refresh token policy. A token issued
 * for a refresh_token grant replaces the redeemed one and keeps its expiry,
 * so refreshing never extends the authorization.
 */
export function issueRefreshTokenIfEnabled(
    session: ChainedAsSession,
    token: AuthorizationServerTokenSettings | undefined,
    grantType: ChainedAsTokenRequestDto["grant_type"],
): string | undefined {
    const policy = refreshTokenPolicy(token);
    if (!policy.enabled) {
        return undefined;
    }

    session.refreshTokenExpiresAt =
        grantType === "refresh_token"
            ? enforcedRefreshTokenExpiry(
                  session.refreshTokenExpiresAt,
                  session.createdAt,
                  policy,
              )
            : refreshTokenExpiresAt(policy, new Date());
    session.refreshToken = randomBytes(32).toString("base64url");

    return session.refreshToken;
}
