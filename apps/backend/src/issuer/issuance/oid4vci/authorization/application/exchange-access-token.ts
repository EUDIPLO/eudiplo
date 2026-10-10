import {
    type AuthorizationCodeGrantIdentifier,
    authorizationCodeGrantIdentifier,
    type Oauth2AuthorizationServer,
    PkceCodeChallengeMethod,
    type PreAuthorizedCodeGrantIdentifier,
    preAuthorizedCodeGrantIdentifier,
    type RefreshTokenGrantIdentifier,
    type RequestLike,
    refreshTokenGrantIdentifier,
    type VerifyAccessTokenRequestReturn,
} from "@openid4vc/oauth2";
import type { RecordFailedTxCodeAttempt } from "../../../../../session/application/record-failed-tx-code-attempt.js";
import type { SessionStore } from "../../../../../session/application/session-store.js";
import type { SessionData } from "../../../../../session/domain/session-data.js";
import type { Oid4vciSettings } from "../../oid4vci-settings.js";
import type { DpopProofReplayRegistry } from "../../ports/dpop-proof-replay-registry.js";
import { OAuthError } from "../domain/oauth-error.js";
import { assertOfferRedeemable } from "../domain/offer-redemption.js";
import { checkS256Pkce } from "../domain/pkce.js";
import {
    describeLibraryError,
    describeMalformedTokenRequest,
    oauthErrorFromLibrary,
    toTokenErrorCode,
} from "../domain/token-errors.js";
import {
    assertCodeIssuedForGrant,
    assertIssuedToClient,
    authorizationDetailsForToken,
    builtInAccessTokenSettings,
    clientInstanceKeyThumbprint,
    DEFAULT_TX_CODE_MAX_ATTEMPTS,
    enforcedRefreshTokenExpiry,
    findBuiltInAuthorizationServer,
    hashAuthorizationCode,
    hashRefreshToken,
    isTxCodeLocked,
    preAuthorizedCodeExpiresAt,
    refreshTokenExpiresAt,
    resolveRefreshTokenPolicy,
    TX_CODE_LOCKED_DESCRIPTION,
} from "../domain/token-grant-rules.js";
import { resolveWalletAttestationPolicy } from "../domain/wallet-attestation-policy.js";
import type { AccessTokenSigningKeys } from "../ports/access-token-signing-keys.js";
import type { BuiltInAuthorizationServerConfiguration } from "../ports/built-in-authorization-server-configuration.js";
import type { ClientAttestationVerifier } from "../ports/client-attestation-verifier.js";
import type { OAuthAuthorizationServerFactory } from "../ports/oauth-authorization-server-factory.js";
import { dpopProofVerification } from "../shared/dpop.util.js";
import type { BuildBuiltInAuthorizationServerMetadata } from "./build-built-in-authorization-server-metadata.js";

interface AuthorizationCodeGrant {
    grantType: AuthorizationCodeGrantIdentifier;
    code: string;
}

interface PreAuthorizedCodeGrant {
    grantType: PreAuthorizedCodeGrantIdentifier;
    preAuthorizedCode: string;
    txCode?: string;
}

interface RefreshTokenGrant {
    grantType: RefreshTokenGrantIdentifier;
    refreshToken: string;
}

type ParsedAccessTokenRequest = ReturnType<
    Oauth2AuthorizationServer["parseAccessTokenRequest"]
>;

export interface AccessTokenRequest {
    tenantId: string;
    /** Form body of the token request. */
    body: any;
    /** Request as seen by the client: absolute URL and normalized headers. */
    request: RequestLike;
}

/**
 * Token endpoint of the built-in authorization server (RFC 6749 Section 3.2,
 * OID4VCI Section 6): authorization_code with PKCE, pre-authorized_code with
 * `tx_code` lockout, and refresh_token. Every rejection is an
 * {@link OAuthError}.
 */
/**
 * The code the grant must carry: only the hash of a code is stored, so the
 * presented code is expected when its hash is the stored one.
 */
function storedCode(presented: string, storedHash: string | undefined): string {
    if (!storedHash || hashAuthorizationCode(presented) !== storedHash) {
        throw new OAuthError(
            "invalid_grant",
            "The provided authorization code is invalid or expired",
        );
    }
    return presented;
}

export class ExchangeAccessToken {
    constructor(
        private readonly servers: OAuthAuthorizationServerFactory,
        private readonly sessions: Pick<
            SessionStore,
            | "getByAuthorizationCode"
            | "getByRefreshToken"
            | "updateForTenant"
            | "updateIfUnconsumed"
        >,
        private readonly txCodeAttempts: Pick<
            RecordFailedTxCodeAttempt,
            "execute"
        >,
        private readonly configuration: BuiltInAuthorizationServerConfiguration,
        private readonly metadata: Pick<
            BuildBuiltInAuthorizationServerMetadata,
            "execute"
        >,
        private readonly clientAttestation: ClientAttestationVerifier,
        private readonly signingKeys: AccessTokenSigningKeys,
        private readonly settings: Oid4vciSettings,
        private readonly dpopProofs: DpopProofReplayRegistry,
    ) {}

    async execute({ tenantId, body, request }: AccessTokenRequest) {
        let parsed: ParsedAccessTokenRequest;
        try {
            parsed = this.servers.forTenant(tenantId).parseAccessTokenRequest({
                accessTokenRequest: body,
                request,
            });
        } catch (err) {
            throw new OAuthError(
                "invalid_request",
                describeLibraryError(err) ??
                    describeMalformedTokenRequest(body),
            );
        }
        const grantType = parsed.grant.grantType;
        const isRefreshGrant = grantType === refreshTokenGrantIdentifier;

        const session = await this.findSession(tenantId, parsed);

        // Single use: sessions consumed by the token or credential endpoint
        // cannot be redeemed again. Refresh tokens remain usable.
        if (!isRefreshGrant && session.consumed) {
            throw new OAuthError(
                "invalid_grant",
                "The credential offer has already been used",
            );
        }
        // The offer lifetime limits redeeming the code only; refresh tokens
        // keep their own lifetime after the session is fetched or completed.
        if (!isRefreshGrant) {
            assertOfferRedeemable(session, new Date(), "invalid_grant");
            assertCodeIssuedForGrant(
                grantType,
                session.credentialPayload?.flow,
            );
        }

        const issuanceConfig =
            await this.configuration.issuanceConfiguration(tenantId);
        const refreshTokenPolicy = resolveRefreshTokenPolicy(issuanceConfig);
        if (isRefreshGrant && !refreshTokenPolicy.enabled) {
            throw new OAuthError(
                "unsupported_grant_type",
                "Refresh tokens are disabled for this authorization server",
            );
        }
        const accessTokenSettings = builtInAccessTokenSettings(issuanceConfig);
        const authorizationServerMetadata =
            await this.metadata.execute(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            findBuiltInAuthorizationServer(issuanceConfig),
        );

        await this.clientAttestation
            .verify(
                tenantId,
                parsed.clientAttestation,
                authorizationServerMetadata.issuer,
                walletAttestationPolicy.walletAttestationRequired,
                walletAttestationPolicy.walletProviderTrustLists,
            )
            .catch((err) => {
                throw new OAuthError(
                    "invalid_client",
                    err instanceof Error
                        ? err.message
                        : "Client attestation validation failed",
                    { clientAuthenticationFailed: true },
                );
            });

        const clientAttestationJwt =
            parsed.clientAttestation?.clientAttestationJwt;
        const clientKeyJkt =
            await clientInstanceKeyThumbprint(clientAttestationJwt);
        if (
            isRefreshGrant &&
            session.client_key_jkt &&
            session.client_key_jkt !== clientKeyJkt
        ) {
            // OAuth2-ATCA 10.3: refresh tokens are bound to the client instance key.
            throw new OAuthError(
                "invalid_grant",
                "The refresh_token is bound to a different client instance",
            );
        }

        if (grantType === authorizationCodeGrantIdentifier || isRefreshGrant) {
            assertIssuedToClient(
                session.auth_queries?.client_id,
                body?.client_id,
                clientAttestationJwt,
            );
        }

        // RFC 6749 Section 4.1.3: a redirect_uri sent with the token request
        // must equal the one bound by the pushed authorization request. It
        // stays optional: OAuth 2.1 and FAPI 2.0 drop the requirement because
        // PKCE, which PAR enforces here, already binds the code to the client
        // that started the flow. Codes without a bound redirect_uri (e.g.
        // interactive authorization) have nothing to compare against.
        const boundRedirectUri = session.auth_queries?.redirect_uri;
        if (
            grantType === authorizationCodeGrantIdentifier &&
            body?.redirect_uri !== undefined &&
            boundRedirectUri !== undefined &&
            body.redirect_uri !== boundRedirectUri
        ) {
            throw new OAuthError(
                "invalid_grant",
                "redirect_uri does not match the authorization request",
            );
        }

        // PAR and the interactive authorization endpoint bind every
        // authorization code to an S256 code_challenge.
        if (
            grantType === authorizationCodeGrantIdentifier &&
            checkS256Pkce(
                session.auth_queries?.code_challenge,
                session.auth_queries?.code_challenge_method,
                body?.code_verifier,
            ) !== "valid"
        ) {
            throw new OAuthError("invalid_grant", "PKCE verification failed");
        }

        const server = this.servers.forTenant(tenantId, session.id);
        const allowedSigningAlgs =
            authorizationServerMetadata.dpop_signing_alg_values_supported;
        const dpopProofChecks = dpopProofVerification(this.dpopProofs);
        let dpop: VerifyAccessTokenRequestReturn["dpop"];

        if (grantType === preAuthorizedCodeGrantIdentifier) {
            const maxAttempts =
                issuanceConfig.txCodeMaxAttempts ??
                DEFAULT_TX_CODE_MAX_ATTEMPTS;
            // Brute-force protection: reject once the session is locked.
            if (
                session.credentialPayload?.tx_code &&
                isTxCodeLocked(session.txCodeFailedAttempts, maxAttempts)
            ) {
                throw new OAuthError(
                    "invalid_grant",
                    TX_CODE_LOCKED_DESCRIPTION,
                    {
                        logDetail: `Session ${session.id} is locked after ${session.txCodeFailedAttempts} failed tx_code attempts`,
                    },
                );
            }

            ({ dpop } = await server
                .verifyPreAuthorizedCodeAccessTokenRequest({
                    grant: parsed.grant as PreAuthorizedCodeGrant,
                    accessTokenRequest: parsed.accessTokenRequest,
                    request,
                    dpop: {
                        required: accessTokenSettings.dpopRequired,
                        allowedSigningAlgs,
                        jwt: parsed.dpop?.jwt,
                        ...dpopProofChecks,
                    },
                    authorizationServerMetadata,
                    expectedPreAuthorizedCode: storedCode(
                        (parsed.grant as PreAuthorizedCodeGrant)
                            .preAuthorizedCode,
                        session.authorization_code,
                    ),
                    expectedTxCode: session.credentialPayload?.tx_code,
                    preAuthorizedCodeExpiresAt: preAuthorizedCodeExpiresAt(
                        session.createdAt,
                        await this.configuration.sessionTtlSeconds(tenantId),
                    ),
                })
                .catch(async (err) => {
                    throw await this.preAuthorizedCodeError(
                        err,
                        tenantId,
                        session,
                        maxAttempts,
                        (parsed.grant as PreAuthorizedCodeGrant).txCode,
                    );
                }));
        }

        if (grantType === authorizationCodeGrantIdentifier) {
            ({ dpop } = await server
                .verifyAuthorizationCodeAccessTokenRequest({
                    grant: parsed.grant as AuthorizationCodeGrant,
                    accessTokenRequest: parsed.accessTokenRequest,
                    expectedCode: storedCode(
                        (parsed.grant as AuthorizationCodeGrant).code,
                        session.authorization_code,
                    ),
                    codeExpiresAt: session.authorization_code_expires_at,
                    request,
                    dpop: {
                        required: accessTokenSettings.dpopRequired,
                        allowedSigningAlgs,
                        jwt: parsed.dpop?.jwt,
                        expectedJwkThumbprint: session.dpop_jkt,
                        ...dpopProofChecks,
                    },
                    // Checked above already; without it the library rejects
                    // every code_verifier as a PKCE downgrade (RFC 9700 4.8.2).
                    pkce: {
                        codeChallenge: session.auth_queries!.code_challenge!,
                        codeChallengeMethod: PkceCodeChallengeMethod.S256,
                        codeVerifier: parsed.pkceCodeVerifier,
                    },
                    authorizationServerMetadata,
                })
                .catch((err) => {
                    throw oauthErrorFromLibrary(err);
                }));
        }

        if (isRefreshGrant) {
            ({ dpop } = await server
                .verifyRefreshTokenAccessTokenRequest({
                    grant: parsed.grant as RefreshTokenGrant,
                    accessTokenRequest: parsed.accessTokenRequest,
                    // The session was found by the hash of this token, and
                    // only the hash is stored.
                    expectedRefreshToken: (parsed.grant as RefreshTokenGrant)
                        .refreshToken,
                    request,
                    // RFC 9449 Section 5: refresh tokens of public clients stay bound to the DPoP key;
                    // attested clients are bound via client authentication and may use a new key.
                    dpop: {
                        required:
                            accessTokenSettings.dpopRequired ||
                            !!session.dpop_jkt,
                        allowedSigningAlgs,
                        jwt: parsed.dpop?.jwt,
                        expectedJwkThumbprint: clientAttestationJwt
                            ? undefined
                            : session.dpop_jkt,
                        ...dpopProofChecks,
                    },
                    authorizationServerMetadata,
                    // Refresh tokens stored without an expiry still expire.
                    refreshTokenExpiresAt: enforcedRefreshTokenExpiry(
                        session.refresh_token_expires_at,
                        session.createdAt,
                        refreshTokenPolicy,
                    ),
                })
                .catch((err) => {
                    throw oauthErrorFromLibrary(err);
                }));
        }

        // Key of the built-in entry, then the issuance key, then the default key.
        const signingKeyId =
            accessTokenSettings.signingKeyId ||
            (await this.signingKeys.defaultKeyId(tenantId));
        const publicJwk = await this.signingKeys.publicJwk(
            tenantId,
            signingKeyId,
        );

        // The JWT (for the credential endpoint) and the token response (for
        // the wallet) carry the same authorization_details (OID4VCI Section 6).
        const authorizationDetails = authorizationDetailsForToken(session);

        const tokenResponse = await server
            .createAccessTokenResponse({
                audience: `${this.settings.publicUrl}/issuers/${tenantId}`,
                signer: {
                    method: "jwk",
                    alg: "ES256",
                    publicJwk,
                    kid: signingKeyId,
                },
                subject: session.id,
                expiresInSeconds: accessTokenSettings.lifetimeSeconds,
                authorizationServer: authorizationServerMetadata.issuer,
                clientId: body?.client_id,
                dpop,
                // FAPI 2.0 SP 5.3.2.1: no refresh token rotation.
                refreshToken: refreshTokenPolicy.enabled && !isRefreshGrant,
                additionalAccessTokenPayload: authorizationDetails
                    ? { authorization_details: authorizationDetails }
                    : undefined,
                additionalAccessTokenResponsePayload: authorizationDetails
                    ? { authorization_details: authorizationDetails }
                    : undefined,
            })
            .catch((err) => {
                throw new OAuthError(
                    "invalid_request",
                    "Failed to create access token response",
                    {
                        logDetail: "Error creating access token response:",
                        cause: err,
                    },
                );
            });

        if (!isRefreshGrant) {
            const refreshTokenExpiry = tokenResponse.refresh_token
                ? refreshTokenExpiresAt(refreshTokenPolicy, new Date())
                : undefined;

            // Atomic single use: of concurrent requests for the same code,
            // only the first may mark the session consumed and receive a token.
            const redeemed = await this.sessions.updateIfUnconsumed(
                session.tenantId,
                session.id,
                {
                    consumed: true,
                    dpop_jkt: dpop?.jwkThumbprint ?? session.dpop_jkt,
                    client_key_jkt: clientKeyJkt,
                    ...(tokenResponse.refresh_token
                        ? {
                              refresh_token: hashRefreshToken(
                                  tokenResponse.refresh_token,
                              ),
                              refresh_token_expires_at: refreshTokenExpiry,
                          }
                        : {}),
                },
            );
            if (!redeemed) {
                throw new OAuthError(
                    "invalid_grant",
                    "The credential offer has already been used",
                );
            }
        }

        return tokenResponse;
    }

    private findSession(
        tenantId: string,
        parsed: ParsedAccessTokenRequest,
    ): Promise<SessionData> {
        if (parsed.grant.grantType === refreshTokenGrantIdentifier) {
            return this.sessions
                .getByRefreshToken(
                    tenantId,
                    hashRefreshToken(parsed.grant.refreshToken),
                )
                .catch(() => {
                    throw new OAuthError(
                        "invalid_grant",
                        "The provided refresh_token is invalid or expired",
                    );
                });
        }
        // authorization_code and pre-authorized_code share the code column.
        const code = (parsed.accessTokenRequest["pre-authorized_code"] ??
            parsed.accessTokenRequest.code) as string | undefined;
        return this.sessions
            .getByAuthorizationCode(
                tenantId,
                code && hashAuthorizationCode(code),
            )
            .catch(() => {
                throw new OAuthError(
                    "invalid_grant",
                    "The provided authorization code is invalid or expired",
                );
            });
    }

    /**
     * Map a failed pre-authorized code verification. A wrong `tx_code` is
     * counted and locks the code once the configured limit is reached.
     *
     * The OAuth library reports its error code in `errorResponse.error` and
     * signals a wrong transaction code as `invalid_grant` (OID4VCI 1.0,
     * Section 6.3), so a wrong `tx_code` is recognized by comparing it with the
     * expected value. DPoP and client attestation are checked by the library
     * before the codes and report different error codes, so they are not
     * counted.
     */
    private async preAuthorizedCodeError(
        err: any,
        tenantId: string,
        session: SessionData,
        maxAttempts: number,
        providedTxCode: string | undefined,
    ): Promise<OAuthError> {
        const errorCode = toTokenErrorCode(
            err?.errorResponse?.error ?? err?.error,
        );
        const expectedTxCode = session.credentialPayload?.tx_code;
        const wrongTxCode =
            errorCode === "invalid_tx_code" ||
            (errorCode === "invalid_grant" &&
                !!expectedTxCode &&
                !!providedTxCode &&
                providedTxCode !== expectedTxCode);
        let logDetail: string | undefined;
        if (wrongTxCode) {
            const { failedAttempts, locked } =
                await this.txCodeAttempts.execute(
                    tenantId,
                    session.id,
                    maxAttempts,
                );
            if (locked) {
                return new OAuthError(
                    "invalid_grant",
                    TX_CODE_LOCKED_DESCRIPTION,
                    {
                        logDetail: `Session ${session.id} locked after ${failedAttempts} failed tx_code attempts`,
                    },
                );
            }
            logDetail = `Failed tx_code attempt ${failedAttempts}/${maxAttempts} for session ${session.id}`;
        }
        return new OAuthError(errorCode, describeLibraryError(err), {
            logDetail,
        });
    }
}
