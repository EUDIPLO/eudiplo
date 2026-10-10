import { createHash } from "node:crypto";
import { preAuthorizedCodeGrantIdentifier } from "@openid4vc/oauth2";
import { calculateJwkThumbprint, decodeJwt, type JWK } from "jose";
import { OAuthError } from "./oauth-error.js";
import type { WalletAttestationPolicyConfig } from "./wallet-attestation-policy.js";

/** OID4VCI Section 6.3 brute-force protection default for `tx_code`. */
export const DEFAULT_TX_CODE_MAX_ATTEMPTS = 5;

export const TX_CODE_LOCKED_DESCRIPTION =
    "Too many failed tx_code attempts. The pre-authorized code has been invalidated.";

/** Default lifetime of access tokens of the built-in authorization server: five minutes. */
const ACCESS_TOKEN_LIFETIME_SECONDS = 300;

/** Default lifetime of refresh tokens of every hosted authorization server: 30 days. */
export const DEFAULT_REFRESH_TOKEN_LIFETIME_SECONDS = 2592000;

/** `token` settings of a hosted authorization server entry. */
export interface AuthorizationServerTokenSettings {
    lifetimeSeconds?: number;
    signingKeyId?: string;
    refreshTokenEnabled?: boolean;
    refreshTokenExpiresInSeconds?: number;
}

/** Settings of the `built-in` authorization server entry. */
export interface BuiltInAuthorizationServerSettings
    extends WalletAttestationPolicyConfig {
    token?: AuthorizationServerTokenSettings;
    requireDPoP?: boolean;
}

interface ConfiguredAuthorizationServer
    extends BuiltInAuthorizationServerSettings {
    type?: string;
    enabled?: boolean;
}

interface IssuanceAuthorizationSettings {
    authorizationServers?: ConfiguredAuthorizationServer[] | null;
    signingKeyId?: string | null;
    dPopRequired?: boolean | null;
}

export interface RefreshTokenPolicy {
    enabled: boolean;
    expiresInSeconds: number;
}

/**
 * Refresh token policy shared by all authorization servers EUDIPLO hosts
 * (built-in, chained and OID4VP): enabled unless `refreshTokenEnabled` is
 * `false`, valid for `refreshTokenExpiresInSeconds` or 30 days. A refresh
 * token never lives unbounded.
 */
export function refreshTokenPolicy(
    token: AuthorizationServerTokenSettings | null | undefined,
): RefreshTokenPolicy {
    return {
        enabled: token?.refreshTokenEnabled !== false,
        expiresInSeconds:
            token?.refreshTokenExpiresInSeconds ??
            DEFAULT_REFRESH_TOKEN_LIFETIME_SECONDS,
    };
}

/** Expiry of a refresh token issued at `issuedAt` under `policy`. */
export function refreshTokenExpiresAt(
    policy: RefreshTokenPolicy,
    issuedAt: Date,
): Date {
    return new Date(issuedAt.getTime() + policy.expiresInSeconds * 1000);
}

/**
 * Expiry enforced when a refresh token is redeemed: the stored one, or, for
 * tokens stored without an expiry, the policy lifetime counted from the
 * creation of the session they were issued for.
 */
export function enforcedRefreshTokenExpiry(
    storedExpiresAt: Date | null | undefined,
    sessionCreatedAt: Date,
    policy: RefreshTokenPolicy,
): Date {
    return storedExpiresAt ?? refreshTokenExpiresAt(policy, sessionCreatedAt);
}

/**
 * Value stored in place of a refresh token, so that the database never holds
 * a usable token: the base64url SHA-256 hash. Refresh tokens are 256-bit
 * random values, so an unsalted hash cannot be reversed by guessing.
 */
export function hashRefreshToken(refreshToken: string): string {
    return createHash("sha256").update(refreshToken).digest("base64url");
}

/**
 * Value stored in place of an authorization code or pre-authorized code, for
 * the same reason as {@link hashRefreshToken}. Codes are random UUIDs or
 * 256-bit values, so an unsalted hash cannot be reversed by guessing either.
 */
export function hashAuthorizationCode(code: string): string {
    return createHash("sha256").update(code).digest("base64url");
}

/** Refresh token policy of the built-in authorization server entry. */
export function resolveRefreshTokenPolicy(
    issuanceConfig: IssuanceAuthorizationSettings,
): RefreshTokenPolicy {
    return refreshTokenPolicy(
        findBuiltInAuthorizationServer(issuanceConfig)?.token,
    );
}

/** The enabled `built-in` authorization server entry, if configured. */
export function findBuiltInAuthorizationServer(
    issuanceConfig: IssuanceAuthorizationSettings,
): BuiltInAuthorizationServerSettings | undefined {
    return (issuanceConfig.authorizationServers ?? []).find(
        (candidate) =>
            candidate.enabled !== false && candidate.type === "built-in",
    );
}

/** Access token settings of the built-in authorization server. */
export interface BuiltInAccessTokenSettings {
    lifetimeSeconds: number;
    /** Key chain id; `undefined` selects the tenant's default key. */
    signingKeyId?: string;
    /** DPoP at the token endpoint: issuance `dPopRequired` or the entry's `requireDPoP`. */
    dpopRequired: boolean;
}

/**
 * Access token settings of the built-in authorization server. The signing key
 * is the entry's `token.signingKeyId`, then the issuance `signingKeyId`, then
 * the tenant default.
 */
export function builtInAccessTokenSettings(
    issuanceConfig: IssuanceAuthorizationSettings,
): BuiltInAccessTokenSettings {
    const server = findBuiltInAuthorizationServer(issuanceConfig);
    return {
        lifetimeSeconds:
            server?.token?.lifetimeSeconds ?? ACCESS_TOKEN_LIFETIME_SECONDS,
        signingKeyId:
            server?.token?.signingKeyId ||
            issuanceConfig.signingKeyId ||
            undefined,
        dpopRequired: !!issuanceConfig.dPopRequired || !!server?.requireDPoP,
    };
}

/** Whether a pre-authorized code with a `tx_code` is locked after failed attempts. */
export function isTxCodeLocked(
    failedAttempts: number | undefined,
    maxAttempts: number,
): boolean {
    return (failedAttempts ?? 0) >= maxAttempts;
}

/**
 * Thumbprint of the client instance key (`cnf.jwk`) from an already verified
 * client attestation (OAuth2-ATCA Section 10.3).
 */
export async function clientInstanceKeyThumbprint(
    clientAttestationJwt: string | undefined,
): Promise<string | undefined> {
    if (!clientAttestationJwt) {
        return undefined;
    }
    const jwk = (decodeJwt(clientAttestationJwt).cnf as { jwk?: JWK })?.jwk;
    return jwk ? calculateJwkThumbprint(jwk, "sha256") : undefined;
}

/**
 * Pre-authorized codes and authorization codes are stored in the same session
 * column, so a code is only redeemable with the grant it was issued for: the
 * pre-authorized code of a pre-authorized offer with the pre-authorized_code
 * grant, any other code with the authorization_code grant. Otherwise switching
 * the grant type would skip the `tx_code` of a pre-authorized code or the PKCE
 * and client binding of an authorization code.
 */
export function assertCodeIssuedForGrant(
    grantType: string,
    offerFlow: string | undefined,
): void {
    const preAuthorizedGrant = grantType === preAuthorizedCodeGrantIdentifier;
    if (preAuthorizedGrant !== (offerFlow === "pre_authorized_code")) {
        throw new OAuthError(
            "invalid_grant",
            "The provided code was not issued for this grant_type",
        );
    }
}

/**
 * Ensure the authorization code (or refresh token) is redeemed by the client
 * it was issued to (RFC 6749 Section 4.1.3). An attested client identifier
 * (`sub` of the verified client attestation) takes precedence over `client_id`.
 */
export function assertIssuedToClient(
    expectedClientId: string | undefined,
    requestClientId: string | undefined,
    clientAttestationJwt: string | undefined,
): void {
    const attestedClientId = clientAttestationJwt
        ? (decodeJwt(clientAttestationJwt).sub as string | undefined)
        : undefined;

    if (
        requestClientId &&
        attestedClientId &&
        requestClientId !== attestedClientId
    ) {
        throw new OAuthError(
            "invalid_client",
            "client_id does not match the client attestation",
        );
    }

    const presentedClientId = attestedClientId ?? requestClientId;
    if (
        expectedClientId &&
        presentedClientId &&
        presentedClientId !== expectedClientId
    ) {
        throw new OAuthError(
            "invalid_grant",
            "The authorization code was issued to another client",
        );
    }
}

/**
 * Build the RFC 9396 `authorization_details` bound to the issued access token
 * (OID4VCI Sections 6 and 7):
 *
 * - `openid_credential` entries of the (pushed) authorization request, or
 * - the `credential_configuration_ids` of the credential offer.
 *
 * Each entry carries `credential_identifiers` (OID4VCI Final Section 6.2).
 * Returns `undefined` when nothing can be derived.
 */
export function authorizationDetailsForToken(session: {
    auth_queries?: { authorization_details?: unknown };
    credentialPayload?: unknown;
}): Record<string, unknown>[] | undefined {
    const raw = session.auth_queries?.authorization_details;
    let requested: Record<string, unknown>[] | undefined;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                requested = parsed as Record<string, unknown>[];
            }
        } catch {
            // Malformed JSON falls through to the offer-based default.
        }
    } else if (Array.isArray(raw)) {
        requested = raw;
    }

    if (requested && requested.length > 0) {
        return requested
            .filter(
                (ad) => (ad.type as string | undefined) === "openid_credential",
            )
            .map((ad) => ({
                type: "openid_credential",
                credential_configuration_id: ad.credential_configuration_id,
                credential_identifiers: [
                    ad.credential_configuration_id as string,
                ],
            }))
            .filter(
                (ad) =>
                    typeof ad.credential_configuration_id === "string" &&
                    (ad.credential_configuration_id as string).length > 0,
            );
    }

    const offerIds: unknown = (
        session.credentialPayload as
            | { credentialConfigurationIds?: unknown }
            | undefined
    )?.credentialConfigurationIds;
    if (Array.isArray(offerIds) && offerIds.length > 0) {
        return offerIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => ({
                type: "openid_credential",
                credential_configuration_id: id,
                credential_identifiers: [id],
            }));
    }

    return undefined;
}

/**
 * A pre-authorized code is valid for the lifetime of its issuance session:
 * from session creation for the tenant's session time-to-live. Session cleanup
 * removes expired sessions only periodically, so the token endpoint enforces
 * the bound itself.
 */
export function preAuthorizedCodeExpiresAt(
    sessionCreatedAt: Date,
    sessionTtlSeconds: number,
): Date {
    return new Date(sessionCreatedAt.getTime() + sessionTtlSeconds * 1000);
}
