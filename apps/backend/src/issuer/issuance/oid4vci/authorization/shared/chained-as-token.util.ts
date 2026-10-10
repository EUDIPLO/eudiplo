import { randomBytes } from "node:crypto";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import type { CallbackContext } from "@openid4vc/oauth2";
import type { DpopProofReplayRegistry } from "../../ports/dpop-proof-replay-registry.js";
import {
    type ChainedAsSession,
    ChainedAsSessionStatus,
} from "../domain/chained-as-session.js";
import { OAuthError } from "../domain/oauth-error.js";
import {
    type AuthorizationServerTokenSettings,
    enforcedRefreshTokenExpiry,
    hashRefreshToken,
    type RefreshTokenPolicy,
    refreshTokenExpiresAt,
    refreshTokenPolicy,
} from "../domain/token-grant-rules.js";
import type { ChainedAsSessionRepository } from "../ports/chained-as-session.repository.js";
import { DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED } from "./authorization-server-metadata.util.js";
import { verifyDpopProof } from "./dpop.util.js";
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
            hashRefreshToken(request.refresh_token),
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

/** Verification context for DPoP proofs sent to a chained authorization server. */
export interface ChainedAsDpopVerification {
    /** Issuer of the authorization server; its endpoints are `<issuer>/par` and `<issuer>/token`. */
    issuer: string;
    callbacks: Pick<CallbackContext, "hash" | "verifyJwt">;
    replayRegistry: DpopProofReplayRegistry;
}

/**
 * Verify the DPoP proof sent to the PAR or token endpoint of a chained
 * authorization server (RFC 9449 Section 4.3), bound to the endpoint URL
 * under the configured public URL and the advertised signing algorithms.
 * Returns the RFC 7638 thumbprint of the proof key, or `undefined` without a
 * proof. An invalid proof is rejected with `invalid_dpop_proof`.
 */
export async function verifyChainedAsDpopProof(
    verification: ChainedAsDpopVerification,
    endpoint: "par" | "token",
    dpopJwt: string | undefined,
    binding: { expectedJwkThumbprint?: string; required?: boolean } = {},
): Promise<string | undefined> {
    const { issuer } = verification;
    try {
        return await verifyDpopProof(
            {
                jwt: dpopJwt,
                request: { method: "POST", url: `${issuer}/${endpoint}` },
                authorizationServerMetadata: {
                    issuer,
                    token_endpoint: `${issuer}/token`,
                    dpop_signing_alg_values_supported: [
                        ...DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
                    ],
                },
                ...binding,
            },
            verification.callbacks,
            verification.replayRegistry,
        );
    } catch (error) {
        if (error instanceof OAuthError) {
            throw new BadRequestException({
                error: error.code,
                error_description: error.description,
                message: error.description,
            });
        }
        throw error;
    }
}

/**
 * DPoP binding of a token request (RFC 9449 Sections 5 and 10). A session
 * bound to a DPoP key at PAR, or a server requiring DPoP, needs a valid proof
 * (with the bound key). The access token is DPoP-bound only to a verified
 * proof key, which then also binds the session and its refresh token.
 */
export async function resolveTokenBinding(
    verification: ChainedAsDpopVerification,
    requireDPoP: boolean | undefined,
    session: ChainedAsSession,
    dpopJwt?: string,
): Promise<{ tokenType: string; dpopJkt?: string }> {
    const dpopJkt = await verifyChainedAsDpopProof(
        verification,
        "token",
        dpopJwt,
        {
            expectedJwkThumbprint: session.dpopJkt,
            required: !!requireDPoP || !!session.dpopJkt,
        },
    );

    if (!dpopJkt) {
        return { tokenType: "Bearer" };
    }
    session.dpopJkt = dpopJkt;
    return { tokenType: "DPoP", dpopJkt };
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
    const refreshToken = randomBytes(32).toString("base64url");
    session.refreshToken = hashRefreshToken(refreshToken);

    return refreshToken;
}
