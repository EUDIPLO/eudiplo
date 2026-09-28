/** Lifecycle of a chained authorization server session. */
export enum ChainedAsSessionStatus {
    /** PAR received, waiting for the authorization request. */
    PENDING_AUTHORIZE = "pending_authorize",
    /** Redirected to the upstream OIDC provider. */
    PENDING_UPSTREAM_CALLBACK = "pending_upstream_callback",
    /** Waiting for the OID4VP presentation. */
    PENDING_VP_CALLBACK = "pending_vp_callback",
    /** Authorization code issued to the wallet. */
    AUTHORIZED = "authorized",
    /** Access token issued. */
    TOKEN_ISSUED = "token_issued",
    EXPIRED = "expired",
}

/**
 * Wallet session of an authorization server hosted by EUDIPLO in front of an
 * upstream OIDC provider or an OID4VP presentation (chained AS, chained-AS-VP
 * and managed OID4VP authorization servers).
 */
export interface ChainedAsSession {
    id: string;
    tenantId: string;
    status: ChainedAsSessionStatus;
    /** Issuer state of the issuance session this session authorizes. */
    issuerState: string;
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    walletState?: string;
    scope?: string;
    authorizationDetails?: Record<string, unknown>[];
    dpopJkt?: string;
    upstreamState?: string;
    upstreamNonce?: string;
    upstreamCodeVerifier?: string;
    vpPresentationConfigId?: string;
    vpResponseCode?: string;
    upstreamIdTokenClaims?: Record<string, unknown>;
    upstreamAccessTokenClaims?: Record<string, unknown>;
    authorizationCode?: string;
    authorizationCodeExpiresAt?: Date;
    accessTokenJti?: string;
    refreshToken?: string;
    refreshTokenExpiresAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
}
