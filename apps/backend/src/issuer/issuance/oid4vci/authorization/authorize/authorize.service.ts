import { randomUUID } from "node:crypto";
import {
    BadRequestException,
    ConflictException,
    HttpStatus,
    Injectable,
    Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
    type AuthorizationCodeGrantIdentifier,
    type AuthorizationServerMetadata,
    authorizationCodeGrantIdentifier,
    type HttpMethod,
    Jwk,
    Oauth2AuthorizationServer,
    PreAuthorizedCodeGrantIdentifier,
    preAuthorizedCodeGrantIdentifier,
    pushedAuthorizationRequestUriPrefix,
    type RefreshTokenGrantIdentifier,
    refreshTokenGrantIdentifier,
} from "@openid4vc/oauth2";
import type { Request } from "express";
import { calculateJwkThumbprint, decodeJwt, type JWK } from "jose";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { CryptoService } from "../../../../../crypto/crypto.service.js";
import { KeyChainService } from "../../../../../crypto/key/key-chain.service.js";
import { SessionService } from "../../../../../session/session.service.js";
import { WalletAttestationService } from "../../../../../trust/wallet-attestation.service.js";
import type { TrustListRef } from "../../../../../verifier/presentations/entities/presentation-config.entity.js";
import { IssuanceService } from "../../../../configuration/issuance/issuance.service.js";
import { StatusListConfigService } from "../../../../status-list/status-list-config.service.js";
import { NonceEntity } from "../../entities/nonces.entity.js";
import { TokenErrorException } from "../../exceptions/index.js";
import { getHeadersFromRequest } from "../../util.js";
import {
    buildAuthorizationServerMetadata,
    buildWalletAttestationMetadata,
    DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
    DPOP_PROOF_FRESHNESS,
    resolveWalletAttestationPolicy,
    verifyPkceCodeChallenge,
} from "../shared/index.js";
import { AuthorizeQueries } from "./dto/authorize-request.dto.js";

/** FAPI 2.0 SP 5.3.2.1: authorization codes live at most 60 seconds. */
const AUTHORIZATION_CODE_LIFETIME_SECONDS = 60;
const PAR_REQUEST_URI_LIFETIME_SECONDS = 60;

interface ParsedAccessTokenAuthorizationCodeRequestGrant {
    grantType: AuthorizationCodeGrantIdentifier;
    code: string;
}

interface ParsedAccessTokenPreAuthorizedCodeRequestGrant {
    grantType: PreAuthorizedCodeGrantIdentifier;
    preAuthorizedCode: string;
    txCode?: string;
}

interface ParsedAccessTokenRefreshTokenRequestGrant {
    grantType: RefreshTokenGrantIdentifier;
    refreshToken: string;
}

@Injectable()
export class AuthorizeService {
    private readonly logger = new Logger(AuthorizeService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly cryptoService: CryptoService,
        private readonly sessionService: SessionService,
        private readonly issuanceService: IssuanceService,
        private readonly walletAttestationService: WalletAttestationService,
        private readonly keyChainService: KeyChainService,
        @InjectRepository(NonceEntity)
        private readonly nonceRepository: Repository<NonceEntity>,
        private readonly statusListConfigService: StatusListConfigService,
    ) {}

    getAuthorizationServer(
        tenantId: string,
        sessionId?: string,
    ): Oauth2AuthorizationServer {
        const callbacks = this.cryptoService.getCallbackContext(
            tenantId,
            sessionId,
        );
        return new Oauth2AuthorizationServer({
            callbacks,
        });
    }

    /**
     * Map error codes from the OAuth library to OAuth 2.0 Token Error codes.
     * According to OID4VCI Section 6.3:
     * - invalid_request: Transaction code provided but not expected, or expected but not provided
     * - invalid_tx_code: Wrong transaction code in the Pre-Authorized Code Flow
     * - invalid_grant: Wrong pre-authorized code, or expired code
     * - invalid_client: Anonymous access with pre-authorized code but not supported
     * @param errorCode The error code from the OAuth library
     * @returns The appropriate OAuth 2.0 token error code
     */
    private mapToTokenErrorCode(
        errorCode: string | undefined,
    ):
        | "invalid_request"
        | "invalid_client"
        | "invalid_grant"
        | "invalid_tx_code"
        | "invalid_dpop_proof" {
        if (!errorCode) {
            return "invalid_request";
        }
        // The OAuth library may return these error codes directly
        if (
            errorCode === "invalid_grant" ||
            errorCode === "invalid_client" ||
            errorCode === "invalid_request" ||
            errorCode === "invalid_tx_code" ||
            errorCode === "invalid_dpop_proof"
        ) {
            return errorCode;
        }
        // Wrong tx_code has its own dedicated error code in OID4VCI 1.1 §6.3.
        if (
            errorCode.includes("tx_code") ||
            errorCode.includes("transaction")
        ) {
            return "invalid_tx_code";
        }
        // Wrong or expired pre-authorized code = invalid_grant
        if (
            errorCode.includes("pre-authorized") ||
            errorCode.includes("pre_authorized")
        ) {
            return "invalid_grant";
        }
        // Default to invalid_request for malformed requests
        return "invalid_request";
    }

    private extractTokenErrorDescription(error: unknown): string | undefined {
        if (typeof error === "string" && error.trim().length > 0) {
            return error;
        }

        if (!error || typeof error !== "object") {
            return undefined;
        }

        const candidate = error as {
            error_description?: unknown;
            errorResponse?: { error_description?: unknown };
            message?: unknown;
            cause?: { message?: unknown };
        };

        if (
            typeof candidate.errorResponse?.error_description === "string" &&
            candidate.errorResponse.error_description.trim().length > 0
        ) {
            return candidate.errorResponse.error_description;
        }

        if (
            typeof candidate.error_description === "string" &&
            candidate.error_description.trim().length > 0
        ) {
            return candidate.error_description;
        }

        if (
            typeof candidate.message === "string" &&
            candidate.message.trim().length > 0
        ) {
            return candidate.message;
        }

        if (
            typeof candidate.cause?.message === "string" &&
            candidate.cause.message.trim().length > 0
        ) {
            return candidate.cause.message;
        }

        return undefined;
    }

    private describeMalformedTokenRequest(body: unknown): string {
        if (!body || typeof body !== "object") {
            return "Malformed token request body";
        }

        const tokenRequest = body as Record<string, unknown>;
        const grantType =
            typeof tokenRequest.grant_type === "string"
                ? tokenRequest.grant_type
                : undefined;

        if (!grantType) {
            return "Missing required parameter: grant_type";
        }

        if (
            grantType === authorizationCodeGrantIdentifier &&
            typeof tokenRequest.code !== "string"
        ) {
            return "Missing required parameter: code";
        }

        if (
            grantType === preAuthorizedCodeGrantIdentifier &&
            typeof tokenRequest["pre-authorized_code"] !== "string"
        ) {
            return "Missing required parameter: pre-authorized_code";
        }

        if (
            grantType === refreshTokenGrantIdentifier &&
            typeof tokenRequest.refresh_token !== "string"
        ) {
            return "Missing required parameter: refresh_token";
        }

        return `Invalid token request for grant_type: ${grantType}`;
    }

    getAuthzIssuer(tenantId: string) {
        return `${this.configService.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenantId}`;
    }

    private resolveRefreshTokenConfig(issuanceConfig: {
        authorizationServers?: Array<{
            type?: string;
            enabled?: boolean;
            id?: string;
            token?: {
                refreshTokenEnabled?: boolean;
                refreshTokenExpiresInSeconds?: number;
            };
        }> | null;
    }): {
        enabled: boolean;
        expiresInSeconds?: number;
    } {
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

        // Built-in authorization server defaults.
        return { enabled: true, expiresInSeconds: 2592000 };
    }

    private getBuiltInAuthorizationServerConfig(issuanceConfig: {
        authorizationServers?: Array<{
            type?: string;
            enabled?: boolean;
            walletAttestationRequired?: boolean;
            walletProviderTrustLists?: TrustListRef[];
        }> | null;
    }) {
        return (issuanceConfig.authorizationServers ?? []).find(
            (candidate) =>
                candidate.enabled !== false && candidate.type === "built-in",
        );
    }

    /**
     * Build the RFC 9396 `authorization_details` array that must be bound to the
     * issued access token, per OID4VCI Section 6 / 7. The list of authorized
     * `credential_configuration_id` values is derived from the session:
     *
     *  - If the Wallet sent `authorization_details` in the Authorization /
     *    PAR request (Authorization Code Flow), those values are used.
     *  - Otherwise (Pre-Authorized Code Flow or issuer-initiated offer), the
     *    `credential_configuration_ids` from the Credential Offer are used.
     *
     * Returns `undefined` when no credential bindings can be derived, in which
     * case no `authorization_details` will be placed on the token.
     */
    private buildAuthorizationDetailsForToken(session: {
        auth_queries?: AuthorizeQueries;
        credentialPayload?: any;
    }): Record<string, unknown>[] | undefined {
        // 1. From authorization_details in the (pushed) authorization request.
        const raw = session.auth_queries?.authorization_details;
        let requested: Record<string, unknown>[] | undefined;
        if (typeof raw === "string") {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    requested = parsed as Record<string, unknown>[];
                }
            } catch {
                // ignore malformed JSON, fall through to offer-based defaulting
            }
        } else if (Array.isArray(raw)) {
            requested = raw;
        }

        if (requested && requested.length > 0) {
            return requested
                .filter(
                    (ad) =>
                        (ad.type as string | undefined) === "openid_credential",
                )
                .map((ad) => ({
                    type: "openid_credential",
                    credential_configuration_id: ad.credential_configuration_id,
                    // Per OID4VCI Final Section 6.2, credential_identifiers MUST be
                    // included when authorization_details are returned in the token
                    // response so the Wallet can reference them in the credential request.
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

        // 2. Fallback: credential_configuration_ids from the Credential Offer.
        const offerIds: unknown =
            session.credentialPayload?.credentialConfigurationIds;
        if (Array.isArray(offerIds) && offerIds.length > 0) {
            return offerIds
                .filter((id): id is string => typeof id === "string")
                .map((id) => ({
                    type: "openid_credential",
                    credential_configuration_id: id,
                    // Per OID4VCI Final Section 6.2, credential_identifiers MUST be
                    // included when authorization_details are returned in the token
                    // response so the Wallet can reference them in the credential request.
                    credential_identifiers: [id],
                }));
        }

        return undefined;
    }

    async authzMetadata(
        tenantId: string,
    ): Promise<AuthorizationServerMetadata> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            this.getBuiltInAuthorizationServerConfig(issuanceConfig),
        );
        const refreshTokenConfig =
            this.resolveRefreshTokenConfig(issuanceConfig);

        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");
        const authServer = this.getAuthzIssuer(tenantId);

        // Check if status list aggregation is enabled for this tenant
        const statusListConfig =
            await this.statusListConfigService.getEffectiveConfig(tenantId);
        const statusListAggregationEndpoint = statusListConfig.enableAggregation
            ? `${authServer}/status-management/status-list-aggregation`
            : undefined;

        const metadata = buildAuthorizationServerMetadata({
            issuer: authServer,
            authorizationEndpoint: `${authServer}/authorize`,
            tokenEndpoint: `${authServer}/authorize/token`,
            pushedAuthorizationRequestEndpoint: `${authServer}/authorize/par`,
            jwksUri: `${publicUrl}/.well-known/jwks.json/issuers/${tenantId}`,
            grantTypesSupported: refreshTokenConfig.enabled
                ? [
                      "authorization_code",
                      "refresh_token",
                      "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                  ]
                : [
                      "authorization_code",
                      "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                  ],
            dpopSigningAlgValuesSupported:
                DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
            ...buildWalletAttestationMetadata(
                walletAttestationPolicy.walletAttestationRequired,
            ),
            additionalMetadata: {
                require_pushed_authorization_requests: true,
                authorization_response_iss_parameter_supported: true,
                interactive_authorization_endpoint: `${authServer}/authorize/interactive`,
                status_list_aggregation_endpoint: statusListAggregationEndpoint,
                challenge_endpoint: `${authServer}/authorize/challenge`,
            },
        }) as AuthorizationServerMetadata;

        return this.getAuthorizationServer(
            tenantId,
        ).createAuthorizationServerMetadata(
            metadata as any,
        ) as AuthorizationServerMetadata;
    }

    /**
     * Client Attestation Challenge Endpoint.
     * Generates and stores a nonce for use in the Client Attestation PoP JWT.
     * @see OAuth2-ATCA07-8
     */
    async challengeRequest(
        tenantId: string,
    ): Promise<{ attestation_challenge: string }> {
        const nonce = v4();
        await this.nonceRepository.save({
            nonce,
            tenantId,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        });
        return { attestation_challenge: nonce };
    }

    /**
     * Handle a Pushed Authorization Request (PAR).
     * Validates client attestation if provided/required, creates a session,
     * and returns a request_uri for the authorize endpoint.
     */
    async handlePar(
        tenantId: string,
        body: AuthorizeQueries,
        req: Request,
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<{ expires_in: number; request_uri: string }> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const authorizationServerMetadata = await this.authzMetadata(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            this.getBuiltInAuthorizationServerConfig(issuanceConfig),
        );

        try {
            await this.walletAttestationService.verifyWalletAttestation(
                tenantId,
                clientAttestation,
                authorizationServerMetadata.issuer,
                walletAttestationPolicy.walletAttestationRequired,
                walletAttestationPolicy.walletProviderTrustLists,
            );
        } catch (err) {
            this.logger.warn(
                `Client attestation validation failed for tenant ${tenantId}: ${err instanceof Error ? err.message : "Unknown error"}`,
            );
            throw new TokenErrorException(
                "invalid_client",
                "Client attestation validation failed",
            );
        }

        this.assertValidParRequest(body);

        const url = `${this.configService.getOrThrow<string>("PUBLIC_URL")}${req.url}`;
        const { dpop } = await this.getAuthorizationServer(tenantId)
            .verifyPushedAuthorizationRequest({
                authorizationRequest: body,
                authorizationServerMetadata,
                request: {
                    method: req.method as HttpMethod,
                    url,
                    headers: getHeadersFromRequest(req),
                },
                dpop: {
                    required: false,
                    jwt: req.header("dpop"),
                    jwkThumbprint: body.dpop_jkt,
                    allowedSigningAlgs:
                        authorizationServerMetadata.dpop_signing_alg_values_supported,
                    ...DPOP_PROOF_FRESHNESS,
                },
            })
            .catch((err) => {
                throw this.toTokenErrorException(err);
            });

        const request_uri = `${pushedAuthorizationRequestUriPrefix}${randomUUID()}`;
        const parValues = {
            request_uri,
            request_uri_expires_at: new Date(
                Date.now() + PAR_REQUEST_URI_LIFETIME_SECONDS * 1000,
            ),
            auth_queries: body,
            dpop_jkt: dpop?.jwkThumbprint,
        };

        if (body.issuer_state) {
            const updateResult = await this.sessionService.add(
                body.issuer_state,
                parValues,
            );

            // Some PAR requests do not have a pre-existing issuer_state session.
            // In that case we create a dedicated request_uri session for authorize.
            if (!updateResult.affected) {
                await this.sessionService.create({
                    id: v4(),
                    tenantId,
                    ...parValues,
                });
            }
        } else {
            await this.sessionService.create({
                id: v4(),
                tenantId,
                ...parValues,
            });
        }

        return { expires_in: PAR_REQUEST_URI_LIFETIME_SECONDS, request_uri };
    }

    /**
     * Enforce the FAPI 2.0 / HAIP requirements on the pushed authorization request.
     */
    private assertValidParRequest(body: AuthorizeQueries): void {
        if (body.request_uri) {
            throw new TokenErrorException(
                "invalid_request",
                "The request_uri parameter must not be sent to the PAR endpoint",
            );
        }
        if (body.response_type !== "code") {
            throw new TokenErrorException(
                "unsupported_response_type",
                "Only response_type 'code' is supported",
            );
        }
        if (!body.client_id) {
            throw new TokenErrorException(
                "invalid_request",
                "Missing required parameter: client_id",
            );
        }
        if (!body.redirect_uri) {
            throw new TokenErrorException(
                "invalid_request",
                "Missing required parameter: redirect_uri",
            );
        }
        if (!body.code_challenge) {
            throw new TokenErrorException(
                "invalid_request",
                "Missing required parameter: code_challenge",
            );
        }
        if (body.code_challenge_method !== "S256") {
            throw new TokenErrorException(
                "invalid_request",
                "Only code_challenge_method 'S256' is supported",
            );
        }
    }

    private toTokenErrorException(err: unknown): TokenErrorException {
        if (err instanceof TokenErrorException) {
            return err;
        }
        const errorCode = (err as { errorResponse?: { error?: string } })
            ?.errorResponse?.error;
        return new TokenErrorException(
            this.mapToTokenErrorCode(errorCode),
            this.extractTokenErrorDescription(err),
        );
    }

    /**
     * Build the redirect back to the client, preserving any query component of
     * the registered redirect_uri (RFC 6749 Section 3.1.2).
     */
    private buildAuthorizationResponseUrl(
        redirectUri: string,
        params: Record<string, string | undefined>,
    ): string {
        const url = new URL(redirectUri);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined) {
                url.searchParams.set(key, value);
            }
        }
        return url.toString();
    }

    async sendAuthorizationResponse(
        values: AuthorizeQueries,
        tenantId: string,
    ): Promise<string> {
        if (!values.request_uri) {
            throw new ConflictException(
                "request_uri not found or not provided in the request",
            );
        }

        const session = await this.sessionService
            .getBy({ request_uri: values.request_uri, tenantId })
            .catch(() => {
                throw new BadRequestException({
                    error: "invalid_request_uri",
                    error_description: "Unknown request_uri",
                });
            });

        const authQueries = session.auth_queries;
        if (!authQueries?.redirect_uri) {
            throw new BadRequestException({
                error: "invalid_request_uri",
                error_description: "request_uri has no redirect_uri bound",
            });
        }

        const iss = this.getAuthzIssuer(tenantId);
        const redirectError = (error: string, description: string) =>
            this.buildAuthorizationResponseUrl(authQueries.redirect_uri!, {
                error,
                error_description: description,
                state: authQueries.state,
                iss,
            });

        if (values.client_id !== authQueries.client_id) {
            return redirectError(
                "invalid_request",
                "client_id does not match the pushed authorization request",
            );
        }

        if (
            !session.request_uri_expires_at ||
            session.request_uri_expires_at.getTime() <= Date.now()
        ) {
            return redirectError(
                "invalid_request_uri",
                "request_uri is expired or was already used",
            );
        }

        // Expire the request_uri on use so it cannot be redeemed twice (RFC 9126 Section 7.3).
        await this.sessionService.add(session.id, {
            request_uri_expires_at: new Date(),
        });

        const code = await this.setAuthCode(session.id);
        return this.buildAuthorizationResponseUrl(authQueries.redirect_uri, {
            code,
            state: authQueries.state,
            iss,
        });
    }

    /**
     * Validate the token request.
     * This endpoint is used to exchange the authorization code for an access token.
     * Returns errors according to OID4VCI Section 6.3 Token Error Response.
     * @param body
     * @param req
     * @returns
     */
    async validateTokenRequest(
        body: any,
        req: Request,
        tenantId: string,
    ): Promise<any> {
        const url = `${this.configService.getOrThrow<string>("PUBLIC_URL")}${req.url}`;

        // Parse the access token request - malformed requests return invalid_request
        let parsedAccessTokenRequest;
        try {
            parsedAccessTokenRequest = this.getAuthorizationServer(
                tenantId,
            ).parseAccessTokenRequest({
                accessTokenRequest: body,
                request: {
                    method: req.method as HttpMethod,
                    url,
                    headers: getHeadersFromRequest(req),
                },
            });
        } catch (err: any) {
            // Malformed token request
            throw new TokenErrorException(
                "invalid_request",
                this.extractTokenErrorDescription(err) ??
                    this.describeMalformedTokenRequest(body),
            );
        }

        // Determine how to look up the session based on grant type
        let session;
        if (
            parsedAccessTokenRequest.grant.grantType ===
            refreshTokenGrantIdentifier
        ) {
            // For refresh_token grant, look up by refresh_token
            session = await this.sessionService
                .getBy({
                    refresh_token: parsedAccessTokenRequest.grant.refreshToken,
                    tenantId,
                })
                .catch(() => {
                    throw new TokenErrorException(
                        "invalid_grant",
                        "The provided refresh_token is invalid or expired",
                    );
                });
        } else {
            // For other grants (authorization_code, pre-authorized_code), look up by code
            const authorization_code =
                parsedAccessTokenRequest.accessTokenRequest[
                    "pre-authorized_code"
                ] ?? parsedAccessTokenRequest.accessTokenRequest["code"];
            session = await this.sessionService
                .getBy({
                    authorization_code,
                    tenantId,
                })
                .catch(() => {
                    throw new TokenErrorException(
                        "invalid_grant",
                        "The provided authorization code is invalid or expired",
                    );
                });
        }

        // Enforce single-use validation for sessions already consumed by
        // credential processing. Refresh token grant remains exempt.
        if (
            parsedAccessTokenRequest.grant.grantType !==
                refreshTokenGrantIdentifier &&
            session.consumed
        ) {
            throw new TokenErrorException(
                "invalid_grant",
                "The credential offer has already been used",
            );
        }

        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const refreshTokenConfig =
            this.resolveRefreshTokenConfig(issuanceConfig);

        const authorizationServerMetadata = await this.authzMetadata(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            this.getBuiltInAuthorizationServerConfig(issuanceConfig),
        );

        // Verify wallet attestation if required or provided
        await this.walletAttestationService
            .verifyWalletAttestation(
                tenantId,
                parsedAccessTokenRequest.clientAttestation,
                authorizationServerMetadata.issuer,
                walletAttestationPolicy.walletAttestationRequired,
                walletAttestationPolicy.walletProviderTrustLists,
            )
            .catch((err) => {
                throw new TokenErrorException(
                    "invalid_client",
                    err instanceof Error
                        ? err.message
                        : "Client attestation validation failed",
                    HttpStatus.UNAUTHORIZED,
                );
            });

        const clientKeyJkt = await this.getClientInstanceKeyThumbprint(
            parsedAccessTokenRequest.clientAttestation?.clientAttestationJwt,
        );
        if (
            parsedAccessTokenRequest.grant.grantType ===
                refreshTokenGrantIdentifier &&
            session.client_key_jkt &&
            session.client_key_jkt !== clientKeyJkt
        ) {
            // OAuth2-ATCA 10.3: refresh tokens are bound to the client instance key.
            throw new TokenErrorException(
                "invalid_grant",
                "The refresh_token is bound to a different client instance",
            );
        }

        if (
            parsedAccessTokenRequest.grant.grantType ===
                authorizationCodeGrantIdentifier ||
            parsedAccessTokenRequest.grant.grantType ===
                refreshTokenGrantIdentifier
        ) {
            this.assertAuthorizationCodeBoundToClient(
                session.auth_queries,
                body?.client_id,
                parsedAccessTokenRequest.clientAttestation
                    ?.clientAttestationJwt,
            );
        }

        if (
            parsedAccessTokenRequest.grant.grantType ===
            authorizationCodeGrantIdentifier
        ) {
            if (session.auth_queries?.code_challenge) {
                try {
                    verifyPkceCodeChallenge(
                        session.auth_queries.code_challenge,
                        session.auth_queries.code_challenge_method,
                        body?.code_verifier,
                    );
                } catch {
                    throw new TokenErrorException(
                        "invalid_grant",
                        "PKCE verification failed",
                    );
                }
            }
        }

        let dpopValue;

        if (
            parsedAccessTokenRequest.grant.grantType ===
            preAuthorizedCodeGrantIdentifier
        ) {
            // Brute-force protection: reject if session is already locked out
            if (session.credentialPayload?.tx_code) {
                const maxAttempts = issuanceConfig.txCodeMaxAttempts ?? 5;
                if ((session.txCodeFailedAttempts ?? 0) >= maxAttempts) {
                    this.logger.warn(
                        `Session ${session.id} is locked after ${session.txCodeFailedAttempts} failed tx_code attempts`,
                    );
                    throw new TokenErrorException(
                        "invalid_grant",
                        "Too many failed tx_code attempts. The pre-authorized code has been invalidated.",
                    );
                }
            }

            const { dpop } = await this.getAuthorizationServer(
                tenantId,
                session.id,
            )
                .verifyPreAuthorizedCodeAccessTokenRequest({
                    grant: parsedAccessTokenRequest.grant as ParsedAccessTokenPreAuthorizedCodeRequestGrant,
                    accessTokenRequest:
                        parsedAccessTokenRequest.accessTokenRequest,
                    request: {
                        method: req.method as HttpMethod,
                        url,
                        headers: getHeadersFromRequest(req),
                    },
                    dpop: {
                        required: issuanceConfig.dPopRequired,
                        allowedSigningAlgs:
                            authorizationServerMetadata.dpop_signing_alg_values_supported,
                        jwt: parsedAccessTokenRequest.dpop?.jwt,
                    },

                    authorizationServerMetadata,

                    expectedPreAuthorizedCode: session.authorization_code!,
                    expectedTxCode: session.credentialPayload?.tx_code,
                })
                .catch(async (err) => {
                    // Map verification errors to OAuth 2.0 error codes
                    const errorCode = this.mapToTokenErrorCode(err.error);
                    // On wrong tx_code, increment the failed attempt counter and check for lockout
                    if (errorCode === "invalid_tx_code") {
                        const maxAttempts =
                            issuanceConfig.txCodeMaxAttempts ?? 5;
                        const failedAttempts =
                            await this.sessionService.incrementTxCodeFailedAttempts(
                                session.id,
                            );
                        if (failedAttempts >= maxAttempts) {
                            this.logger.warn(
                                `Session ${session.id} locked after ${failedAttempts} failed tx_code attempts`,
                            );
                            throw new TokenErrorException(
                                "invalid_grant",
                                "Too many failed tx_code attempts. The pre-authorized code has been invalidated.",
                            );
                        }
                        this.logger.warn(
                            `Failed tx_code attempt ${failedAttempts}/${maxAttempts} for session ${session.id}`,
                        );
                    }
                    throw new TokenErrorException(
                        errorCode,
                        this.extractTokenErrorDescription(err),
                    );
                });
            dpopValue = dpop;
        }

        if (
            parsedAccessTokenRequest.grant.grantType ===
            authorizationCodeGrantIdentifier
        ) {
            const { dpop } = await this.getAuthorizationServer(
                tenantId,
                session.id,
            )
                .verifyAuthorizationCodeAccessTokenRequest({
                    grant: parsedAccessTokenRequest.grant as ParsedAccessTokenAuthorizationCodeRequestGrant,
                    accessTokenRequest:
                        parsedAccessTokenRequest.accessTokenRequest,
                    expectedCode: session.authorization_code as string,
                    codeExpiresAt: session.authorization_code_expires_at,
                    request: {
                        method: req.method as HttpMethod,
                        url,
                        headers: getHeadersFromRequest(req),
                    },
                    dpop: {
                        required: issuanceConfig.dPopRequired,
                        allowedSigningAlgs:
                            authorizationServerMetadata.dpop_signing_alg_values_supported,
                        jwt: parsedAccessTokenRequest.dpop?.jwt,
                        expectedJwkThumbprint: session.dpop_jkt,
                        ...DPOP_PROOF_FRESHNESS,
                    },
                    authorizationServerMetadata,
                })
                .catch((err) => {
                    throw this.toTokenErrorException(err);
                });
            dpopValue = dpop;
        }

        if (
            parsedAccessTokenRequest.grant.grantType ===
            refreshTokenGrantIdentifier
        ) {
            // For refresh_token grant, verify the token with the stored refresh_token
            const { dpop } = await this.getAuthorizationServer(
                tenantId,
                session.id,
            )
                .verifyRefreshTokenAccessTokenRequest({
                    grant: parsedAccessTokenRequest.grant as ParsedAccessTokenRefreshTokenRequestGrant,
                    accessTokenRequest:
                        parsedAccessTokenRequest.accessTokenRequest,
                    expectedRefreshToken: session.refresh_token!,
                    request: {
                        method: req.method as HttpMethod,
                        url,
                        headers: getHeadersFromRequest(req),
                    },
                    // RFC 9449 Section 5: refresh tokens of public clients stay bound to the DPoP key;
                    // attested clients are bound via client authentication and may use a new key.
                    dpop: {
                        required:
                            issuanceConfig.dPopRequired || !!session.dpop_jkt,
                        allowedSigningAlgs:
                            authorizationServerMetadata.dpop_signing_alg_values_supported,
                        jwt: parsedAccessTokenRequest.dpop?.jwt,
                        expectedJwkThumbprint: parsedAccessTokenRequest
                            .clientAttestation?.clientAttestationJwt
                            ? undefined
                            : session.dpop_jkt,
                        ...DPOP_PROOF_FRESHNESS,
                    },
                    authorizationServerMetadata,
                    refreshTokenExpiresAt: session.refresh_token_expires_at,
                })
                .catch((err) => {
                    throw this.toTokenErrorException(err);
                });
            dpopValue = dpop;
        }

        const isRefreshGrant =
            parsedAccessTokenRequest.grant.grantType ===
            refreshTokenGrantIdentifier;

        // Use pinned key from issuance config, or fall back to first available key
        const signingKeyId =
            issuanceConfig.signingKeyId ||
            (await this.keyChainService.getKid(tenantId));

        const publicKey = await this.keyChainService.getPublicKey(
            "jwk",
            tenantId,
            signingKeyId,
        );

        // Determine access token lifetime (use credential lifetime if available, otherwise 5 min default)
        const accessTokenExpiresInSeconds = 300;

        // Bind the issued access token to the Credential(s) the Wallet is
        // authorized to request, per OID4VCI Section 6. Both the JWT payload
        // (for resource-server enforcement) and the token response body (for
        // the Wallet) receive the same authorization_details.
        const authorizationDetails =
            this.buildAuthorizationDetailsForToken(session);

        const tokenResponse = await this.getAuthorizationServer(
            tenantId,
            session.id,
        )
            .createAccessTokenResponse({
                audience: `${this.configService.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenantId}`,
                signer: {
                    method: "jwk",
                    alg: "ES256",
                    publicJwk: publicKey as Jwk,
                    kid: signingKeyId,
                },
                subject: session.id,
                expiresInSeconds: accessTokenExpiresInSeconds,
                authorizationServer: authorizationServerMetadata.issuer,
                clientId: req.body.client_id,
                dpop: dpopValue,
                // FAPI 2.0 SP 5.3.2.1: no refresh token rotation.
                refreshToken: refreshTokenConfig.enabled && !isRefreshGrant,
                additionalAccessTokenPayload: authorizationDetails
                    ? { authorization_details: authorizationDetails }
                    : undefined,
                additionalAccessTokenResponsePayload: authorizationDetails
                    ? { authorization_details: authorizationDetails }
                    : undefined,
            })
            .catch((err) => {
                this.logger.error("Error creating access token response:", err);
                // Internal errors during token response creation
                throw new TokenErrorException(
                    "invalid_request",
                    "Failed to create access token response",
                );
            });

        if (!isRefreshGrant) {
            // Calculate refresh token expiration based on configured lifetime
            let refreshTokenExpiresAt: Date | undefined;
            if (
                tokenResponse.refresh_token &&
                refreshTokenConfig.expiresInSeconds
            ) {
                refreshTokenExpiresAt = new Date(
                    Date.now() + refreshTokenConfig.expiresInSeconds * 1000,
                );
            }

            await this.sessionService.add(session.id, {
                consumed: true, // Mark the session as consumed to prevent reuse
                dpop_jkt: dpopValue?.jwkThumbprint ?? session.dpop_jkt,
                client_key_jkt: clientKeyJkt,
                ...(tokenResponse.refresh_token
                    ? {
                          refresh_token: tokenResponse.refresh_token,
                          refresh_token_expires_at: refreshTokenExpiresAt,
                      }
                    : {}),
            });
        }

        return tokenResponse;
    }

    /**Thumbprint of the client instance key (`cnf.jwk`) from an already verified client attestation.
     */
    private async getClientInstanceKeyThumbprint(
        clientAttestationJwt: string | undefined,
    ): Promise<string | undefined> {
        if (!clientAttestationJwt) {
            return undefined;
        }
        const jwk = (decodeJwt(clientAttestationJwt).cnf as { jwk?: JWK })?.jwk;
        return jwk ? calculateJwkThumbprint(jwk, "sha256") : undefined;
    }

    /**
     *
     * Ensure the authorization code is redeemed by the client it was issued to
     * (RFC 6749 Section 4.1.3).
     */
    private assertAuthorizationCodeBoundToClient(
        authQueries: AuthorizeQueries | undefined,
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
            throw new TokenErrorException(
                "invalid_client",
                "client_id does not match the client attestation",
            );
        }

        const expectedClientId = authQueries?.client_id;
        const presentedClientId = attestedClientId ?? requestClientId;
        if (
            expectedClientId &&
            presentedClientId &&
            presentedClientId !== expectedClientId
        ) {
            throw new TokenErrorException(
                "invalid_grant",
                "The authorization code was issued to another client",
            );
        }
    }

    /**
     * Set the authorization code for a session based on the issuer_state and return the code.
     * @param issuer_state
     * @returns
     */
    async setAuthCode(issuer_state: string) {
        const code = randomUUID();
        await this.sessionService.add(issuer_state, {
            authorization_code: code,
            authorization_code_expires_at: new Date(
                Date.now() + AUTHORIZATION_CODE_LIFETIME_SECONDS * 1000,
            ),
        });
        return code;
    }
}
