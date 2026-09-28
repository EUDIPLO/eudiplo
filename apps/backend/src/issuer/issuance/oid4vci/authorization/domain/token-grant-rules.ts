import { calculateJwkThumbprint, decodeJwt, type JWK } from "jose";
import { OAuthError } from "./oauth-error.js";
import type { WalletAttestationPolicyConfig } from "./wallet-attestation-policy.js";

/** OID4VCI Section 6.3 brute-force protection default for `tx_code`. */
export const DEFAULT_TX_CODE_MAX_ATTEMPTS = 5;

export const TX_CODE_LOCKED_DESCRIPTION =
    "Too many failed tx_code attempts. The pre-authorized code has been invalidated.";

/** Access tokens of the built-in authorization server live five minutes. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 300;

/** Built-in default when no authorization server configures refresh tokens: 30 days. */
const DEFAULT_REFRESH_TOKEN_LIFETIME_SECONDS = 2592000;

interface ConfiguredAuthorizationServer {
    type?: string;
    enabled?: boolean;
    token?: {
        refreshTokenEnabled?: boolean;
        refreshTokenExpiresInSeconds?: number;
    };
}

export interface RefreshTokenPolicy {
    enabled: boolean;
    expiresInSeconds?: number;
}

/**
 * Refresh token policy of the built-in authorization server: the token
 * settings of the first enabled, non-external server that configures them,
 * otherwise enabled with a 30 day lifetime.
 */
export function resolveRefreshTokenPolicy(issuanceConfig: {
    authorizationServers?: ConfiguredAuthorizationServer[] | null;
}): RefreshTokenPolicy {
    const server = (issuanceConfig.authorizationServers ?? []).find(
        (candidate) =>
            candidate.enabled !== false &&
            candidate.type !== "external" &&
            !!candidate.token,
    );
    if (server?.token) {
        return {
            enabled: server.token.refreshTokenEnabled ?? true,
            expiresInSeconds: server.token.refreshTokenExpiresInSeconds,
        };
    }
    return {
        enabled: true,
        expiresInSeconds: DEFAULT_REFRESH_TOKEN_LIFETIME_SECONDS,
    };
}

/** The enabled `built-in` authorization server entry, if configured. */
export function findBuiltInAuthorizationServer(issuanceConfig: {
    authorizationServers?: Array<{ type?: string; enabled?: boolean }> | null;
}): WalletAttestationPolicyConfig | undefined {
    return (issuanceConfig.authorizationServers ?? []).find(
        (candidate) =>
            candidate.enabled !== false && candidate.type === "built-in",
    ) as WalletAttestationPolicyConfig | undefined;
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
