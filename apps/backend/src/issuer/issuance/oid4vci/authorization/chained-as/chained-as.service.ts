import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from "@nestjs/common";
import { decodeJwt } from "jose";
import { MetricService, TraceService } from "nestjs-otel";
import { v4 } from "uuid";
import { KeyChainService } from "../../../../../crypto/key/key-chain.service.js";
import { SessionStore } from "../../../../../session/application/session-store.js";
import { assertSessionUsable } from "../../../../../session/domain/session-usability.js";
import { FederationTrustService } from "../../../../../trust/federation-trust.service.js";
import { FederationTrustSource } from "../../../../../trust/types.js";
import { WalletAttestationService } from "../../../../../trust/wallet-attestation.service.js";
import type { TrustListRef } from "../../../../../verifier/presentations/entities/presentation-config.entity.js";
import { AuthorizationIdentity } from "../../../../configuration/credentials/domain/authorization-identity.js";
import type { ChainedAsConfig } from "../../../../configuration/issuance/dto/chained-as-config.dto.js";
import { IssuanceService } from "../../../../configuration/issuance/issuance.service.js";
import {
    OID4VCI_SETTINGS,
    type Oid4vciSettings,
} from "../../oid4vci-settings.js";
import { refreshTokenPolicy } from "../domain/token-grant-rules.js";
import {
    CHAINED_AS_SESSION_REPOSITORY,
    type ChainedAsSessionRepository,
} from "../ports/chained-as-session.repository.js";
import {
    assertPkceCodeChallenge,
    assertTokenRequestSessionValid,
    buildAccessTokenPayload,
    buildAuthorizationCodeRedirect,
    buildAuthorizationErrorRedirect,
    buildAuthorizationServerMetadata,
    buildJwksResponse,
    buildWalletAttestationMetadata,
    ChainedAsParRequestDto,
    ChainedAsParResponseDto,
    type ChainedAsSession,
    ChainedAsSessionStatus,
    ChainedAsTokenRequestDto,
    ChainedAsTokenResponseDto,
    DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
    issueRefreshTokenIfEnabled,
    resolveSessionForTokenRequest,
    resolveTokenBinding,
    resolveWalletAttestationPolicy,
    retainSessionForIssuedTokens,
} from "../shared/index.js";
import {
    OIDC_DISCOVERY_RESOLVER,
    type OidcDiscoveryDocument,
    type OidcDiscoveryResolver,
} from "./ports/oidc-discovery-resolver.js";
import {
    OIDC_TOKEN_EXCHANGER,
    type OidcTokenExchanger,
} from "./ports/oidc-token-exchanger.js";

/**
 * Service implementing Chained Authorization Server functionality.
 *
 * In Chained AS mode, EUDIPLO acts as an OAuth Authorization Server facade:
 * - Receives OAuth requests from wallets
 * - Delegates user authentication to an upstream OIDC provider
 * - Issues its own access tokens containing issuer_state
 *
 * This enables session correlation without requiring modifications to
 * the upstream OIDC provider (e.g., Keycloak).
 */
@Injectable()
export class ChainedAsService {
    private readonly logger = new Logger(ChainedAsService.name);

    /** Cache for upstream OIDC discovery documents */
    private readonly discoveryCache = new Map<
        string,
        { doc: OidcDiscoveryDocument; fetchedAt: number; expiresAt: number }
    >();
    private readonly inFlightDiscoveryRequests = new Map<
        string,
        Promise<OidcDiscoveryDocument>
    >();

    private readonly discoveryHitsCounter;
    private readonly discoveryMissesCounter;
    private readonly discoveryStaleCounter;
    private readonly discoveryFetchesCounter;

    clearDiscoveryCache(): void {
        this.discoveryCache.clear();
        this.inFlightDiscoveryRequests.clear();
    }

    /** Request URI prefix for PAR responses */
    private readonly REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";

    /** Default session lifetime in seconds */
    private readonly SESSION_LIFETIME_SECONDS = 600;

    /** Default authorization code lifetime in seconds */
    private readonly AUTH_CODE_LIFETIME_SECONDS = 300;

    constructor(
        @Inject(OID4VCI_SETTINGS) private readonly settings: Oid4vciSettings,
        @Inject(OIDC_DISCOVERY_RESOLVER)
        private readonly oidcDiscoveryResolver: OidcDiscoveryResolver,
        @Inject(OIDC_TOKEN_EXCHANGER)
        private readonly oidcTokenExchanger: OidcTokenExchanger,
        private readonly keyChainService: KeyChainService,
        private readonly sessionStore: SessionStore,
        private readonly issuanceService: IssuanceService,
        private readonly federationTrustService: FederationTrustService,
        private readonly walletAttestationService: WalletAttestationService,
        private readonly traceService: TraceService,
        @Inject(CHAINED_AS_SESSION_REPOSITORY)
        private readonly sessionRepository: ChainedAsSessionRepository,
        @Optional() private readonly metricService?: MetricService,
    ) {
        this.discoveryHitsCounter = this.metricService?.getCounter(
            "chained_as_discovery_cache_hits_total",
            {
                description:
                    "Total hits on Chained AS upstream discovery cache",
            },
        );
        this.discoveryMissesCounter = this.metricService?.getCounter(
            "chained_as_discovery_cache_misses_total",
            {
                description:
                    "Total misses on Chained AS upstream discovery cache",
            },
        );
        this.discoveryStaleCounter = this.metricService?.getCounter(
            "chained_as_discovery_cache_stale_total",
            {
                description:
                    "Total stale hits on Chained AS upstream discovery cache",
            },
        );
        this.discoveryFetchesCounter = this.metricService?.getCounter(
            "chained_as_discovery_fetches_total",
            {
                description:
                    "Total outbound Chained AS upstream discovery fetches",
            },
        );
    }

    /**
     * Get the base URL for this tenant's Chained AS.
     */
    private getChainedAsBaseUrl(tenantId: string): string {
        const publicUrl = this.settings.publicUrl;
        return `${publicUrl}/issuers/${tenantId}/chained-as`;
    }

    /**
     * Get the Chained AS configuration for a tenant.
     * @throws NotFoundException if chained AS is not configured or not enabled
     */
    async getChainedAsConfig(tenantId: string): Promise<ChainedAsConfig> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        type ChainedServerConfig = {
            id: string;
            enabled?: boolean;
            type: "chained";
            upstream: ChainedAsConfig["upstream"];
            token?: NonNullable<ChainedAsConfig["token"]>;
            requireDPoP?: NonNullable<ChainedAsConfig["requireDPoP"]>;
            walletAttestationRequired?: NonNullable<
                ChainedAsConfig["walletAttestationRequired"]
            >;
            walletProviderTrustLists?: TrustListRef[];
        };

        const chainedServer = (issuanceConfig.authorizationServers ?? []).find(
            (server): server is ChainedServerConfig => {
                const candidate = server as Partial<ChainedServerConfig>;
                return (
                    server.enabled !== false &&
                    server.type === "chained" &&
                    typeof candidate.id === "string" &&
                    candidate.id.length > 0 &&
                    !!candidate.upstream
                );
            },
        );

        if (chainedServer) {
            return {
                enabled: true,
                upstream: chainedServer.upstream,
                token: chainedServer.token,
                requireDPoP: chainedServer.requireDPoP,
                walletAttestationRequired:
                    chainedServer.walletAttestationRequired,
                walletProviderTrustLists:
                    chainedServer.walletProviderTrustLists,
            } as ChainedAsConfig;
        }

        throw new NotFoundException(
            "Chained Authorization Server is not enabled for this tenant",
        );
    }

    /**
     * Fetch the OIDC discovery document from an upstream provider.
     * Results are cached for 5 minutes.
     */
    async getUpstreamDiscovery(
        tenantId: string,
        issuer: string,
    ): Promise<OidcDiscoveryDocument> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const federationTrustSource =
            issuanceConfig.federation &&
            issuanceConfig.federation.trustAnchors?.length
                ? ({
                      mode: issuanceConfig.federation.mode,
                      entityId: issuanceConfig.federation.entityId,
                      trustAnchors: issuanceConfig.federation.trustAnchors,
                      cacheTtlSeconds:
                          issuanceConfig.federation.cacheTtlSeconds,
                      enforceSigningPolicy:
                          issuanceConfig.federation.enforceSigningPolicy,
                  } as FederationTrustSource)
                : undefined;

        await this.assertFederationTrustForUpstreamIssuer(
            issuer,
            federationTrustSource,
        );

        const now = Date.now();
        const cached = this.discoveryCache.get(issuer);
        if (cached && cached.expiresAt > now) {
            this.discoveryHitsCounter?.add(1, { issuer });
            this.logger.debug(`OIDC discovery cache hit for ${issuer}`);
            return cached.doc;
        }

        const inFlight = this.inFlightDiscoveryRequests.get(issuer);
        if (inFlight) {
            this.logger.debug(
                `Deduplicating in-flight OIDC discovery fetch for ${issuer}`,
            );
            return inFlight;
        }

        this.discoveryMissesCounter?.add(1, { issuer });

        const fetchPromise = (async (): Promise<OidcDiscoveryDocument> => {
            this.discoveryFetchesCounter?.add(1, { issuer });

            try {
                const doc = await this.oidcDiscoveryResolver.resolve(issuer);
                // Cache for 5 minutes
                this.discoveryCache.set(issuer, {
                    doc,
                    fetchedAt: Date.now(),
                    expiresAt: Date.now() + 5 * 60 * 1000,
                });

                return doc;
            } catch (error) {
                if (cached && now - cached.fetchedAt <= 60 * 60 * 1000) {
                    this.discoveryStaleCounter?.add(1, { issuer });
                    this.logger.warn(
                        `Failed to fetch OIDC discovery from ${issuer}, returning stale discovery document: ${String(error)}`,
                    );
                    return cached.doc;
                }
                this.logger.error(
                    `Failed to fetch OIDC discovery from ${issuer}`,
                    error,
                );
                throw new BadRequestException(
                    "Failed to fetch upstream OIDC configuration",
                );
            }
        })();

        this.inFlightDiscoveryRequests.set(issuer, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            this.inFlightDiscoveryRequests.delete(issuer);
        }
    }

    private async assertFederationTrustForUpstreamIssuer(
        upstreamIssuer: string,
        federationTrustSource?: FederationTrustSource,
    ): Promise<void> {
        if (!federationTrustSource) {
            return;
        }

        const mode = this.federationTrustService.getMode(federationTrustSource);
        if (mode === "lote-only") {
            return;
        }

        const trustEvaluation =
            await this.federationTrustService.evaluateAuthorizationServerTrust(
                upstreamIssuer,
                federationTrustSource,
            );

        if (!trustEvaluation.trusted) {
            throw new BadRequestException(
                `Upstream issuer is not trusted by OpenID Federation policy: ${trustEvaluation.reason}`,
            );
        }
    }

    /**
     * Handle a Pushed Authorization Request (PAR).
     * Creates a session and returns a request_uri for the authorize endpoint.
     */
    async handlePar(
        tenantId: string,
        request: ChainedAsParRequestDto,
        dpopJkt?: string,
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<ChainedAsParResponseDto> {
        // Validate configuration
        const config = await this.getChainedAsConfig(tenantId);
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        // Validate response_type
        if (request.response_type !== "code") {
            throw new BadRequestException(
                'Invalid response_type, must be "code"',
            );
        }

        // PKCE with S256 is mandatory (HAIP 1.0 Section 4)
        assertPkceCodeChallenge(
            request.code_challenge,
            request.code_challenge_method,
        );

        if (config.requireDPoP && !dpopJkt) {
            throw new BadRequestException("DPoP is required");
        }

        // Verify wallet attestation if provided or required
        const chainedAsUrl = this.getChainedAsBaseUrl(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            config,
        );

        await this.walletAttestationService.verifyWalletAttestation(
            tenantId,
            clientAttestation,
            chainedAsUrl,
            walletAttestationPolicy.walletAttestationRequired,
            walletAttestationPolicy.walletProviderTrustLists,
        );

        // Find the session for the issuer_state (if provided)
        let issuerState = request.issuer_state;
        if (issuerState) {
            // The issuer_state must name an offer that can still be redeemed
            try {
                assertSessionUsable(
                    await this.sessionStore.getForTenant(tenantId, issuerState),
                    new Date(),
                );
            } catch {
                throw new BadRequestException("Invalid issuer_state");
            }
        } else {
            // Generate a new issuer_state if not provided
            issuerState = v4();
        }

        // Create the session
        const sessionId = v4();
        const expiresAt = new Date(
            Date.now() + this.SESSION_LIFETIME_SECONDS * 1000,
        );

        const session = this.sessionRepository.create({
            id: sessionId,
            tenantId,
            status: ChainedAsSessionStatus.PENDING_AUTHORIZE,
            issuerState,
            clientId: request.client_id,
            redirectUri: request.redirect_uri,
            codeChallenge: request.code_challenge,
            codeChallengeMethod: request.code_challenge_method,
            walletState: request.state,
            scope: request.scope,
            authorizationDetails: request.authorization_details,
            dpopJkt,
            expiresAt,
        });

        await this.sessionRepository.save(session);

        // Add session context to span for trace correlation
        this.traceService.getSpan()?.setAttributes({
            "session.id": issuerState,
            "chained_as.session.id": sessionId,
            "session.tenantId": tenantId,
            "chained_as.endpoint": "par",
        });

        this.logger.debug(
            `Created Chained AS PAR session ${sessionId} for tenant ${tenantId}`,
        );

        return {
            request_uri: `${this.REQUEST_URI_PREFIX}${sessionId}`,
            expires_in: this.SESSION_LIFETIME_SECONDS,
        };
    }

    /**
     * Handle the authorize endpoint.
     * Validates the request_uri and redirects to the upstream OIDC provider.
     */
    async handleAuthorize(
        tenantId: string,
        clientId: string,
        requestUri: string,
    ): Promise<string> {
        // Validate configuration
        const config = await this.getChainedAsConfig(tenantId);

        if (!config.upstream) {
            throw new BadRequestException(
                "Upstream OIDC provider not configured",
            );
        }

        // Extract session ID from request_uri
        if (!requestUri.startsWith(this.REQUEST_URI_PREFIX)) {
            throw new BadRequestException("Invalid request_uri format");
        }
        const sessionId = requestUri.slice(this.REQUEST_URI_PREFIX.length);

        // Find the session
        const session = await this.sessionRepository.findForTenant(
            tenantId,
            sessionId,
            ChainedAsSessionStatus.PENDING_AUTHORIZE,
        );

        if (!session) {
            throw new BadRequestException("Invalid or expired request_uri");
        }

        // Add session context to span for trace correlation
        this.traceService.getSpan()?.setAttributes({
            "session.id": session.issuerState,
            "chained_as.session.id": sessionId,
            "session.tenantId": tenantId,
            "chained_as.endpoint": "authorize",
        });

        // Verify client_id matches
        if (session.clientId !== clientId) {
            throw new BadRequestException("Client ID mismatch");
        }

        // Check expiration
        if (session.expiresAt < new Date()) {
            session.status = ChainedAsSessionStatus.EXPIRED;
            await this.sessionRepository.save(session);
            throw new BadRequestException("Session expired");
        }

        // Fetch upstream discovery
        const discovery = await this.getUpstreamDiscovery(
            tenantId,
            config.upstream.issuer,
        );

        // Generate state, nonce, and PKCE for upstream request
        const upstreamState = randomUUID();
        const upstreamNonce = randomUUID();
        const upstreamCodeVerifier = randomBytes(32).toString("base64url");
        const upstreamCodeChallenge = createHash("sha256")
            .update(upstreamCodeVerifier)
            .digest("base64url");

        // Update session with upstream parameters
        session.status = ChainedAsSessionStatus.PENDING_UPSTREAM_CALLBACK;
        session.upstreamState = upstreamState;
        session.upstreamNonce = upstreamNonce;
        session.upstreamCodeVerifier = upstreamCodeVerifier;
        await this.sessionRepository.save(session);

        // Build upstream authorization URL
        const callbackUrl = `${this.getChainedAsBaseUrl(tenantId)}/callback`;
        const upstreamScopes = config.upstream.scopes || ["openid"];

        const authUrl = new URL(discovery.authorization_endpoint);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", config.upstream.clientId);
        authUrl.searchParams.set("redirect_uri", callbackUrl);
        authUrl.searchParams.set("scope", upstreamScopes.join(" "));
        authUrl.searchParams.set("state", upstreamState);
        authUrl.searchParams.set("nonce", upstreamNonce);
        authUrl.searchParams.set("code_challenge", upstreamCodeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");

        this.logger.debug(
            `Redirecting to upstream OIDC: ${authUrl.origin}${authUrl.pathname}`,
        );

        return authUrl.toString();
    }

    /**
     * Build error redirect URL for wallet.
     */
    /**
     * Handle upstream OIDC error in callback.
     */
    private async handleUpstreamError(
        tenantId: string,
        state: string,
        error: string,
        errorDescription?: string,
    ): Promise<string> {
        this.logger.warn(`Upstream OIDC error: ${error} - ${errorDescription}`);
        const session = await this.sessionRepository.findByUpstreamState(
            tenantId,
            state,
        );
        if (session) {
            session.status = ChainedAsSessionStatus.EXPIRED;
            await this.sessionRepository.save(session);
            return buildAuthorizationErrorRedirect(
                session.redirectUri,
                error,
                errorDescription,
                session.walletState,
            );
        }
        throw new BadRequestException("Invalid callback state");
    }

    /**
     * Exchange authorization code with upstream OIDC provider.
     */
    private async exchangeUpstreamCode(
        session: ChainedAsSession,
        code: string,
        config: ChainedAsConfig,
        discovery: OidcDiscoveryDocument,
        callbackUrl: string,
    ): Promise<void> {
        const tokens = await this.oidcTokenExchanger.exchange({
            tokenEndpoint: discovery.token_endpoint,
            code,
            redirectUri: callbackUrl,
            clientId: config.upstream!.clientId,
            clientSecret: config.upstream!.clientSecret,
            codeVerifier: session.upstreamCodeVerifier,
        });

        if (tokens.idToken) {
            session.upstreamIdTokenClaims = decodeJwt(tokens.idToken) as Record<
                string,
                unknown
            >;
        }

        try {
            session.upstreamAccessTokenClaims = decodeJwt(
                tokens.accessToken,
            ) as Record<string, unknown>;
        } catch {
            session.upstreamAccessTokenClaims = {};
        }
    }

    /**
     * Handle the callback from the upstream OIDC provider.
     * Exchanges the code for tokens and redirects back to the wallet.
     */
    async handleUpstreamCallback(
        tenantId: string,
        code: string,
        state: string,
        error?: string,
        errorDescription?: string,
    ): Promise<string> {
        if (error) {
            return this.handleUpstreamError(
                tenantId,
                state,
                error,
                errorDescription,
            );
        }

        const session = await this.sessionRepository.findByUpstreamState(
            tenantId,
            state,
            ChainedAsSessionStatus.PENDING_UPSTREAM_CALLBACK,
        );

        if (!session) {
            throw new BadRequestException("Invalid or expired callback state");
        }

        // Add session context to span for trace correlation
        this.traceService.getSpan()?.setAttributes({
            "session.id": session.issuerState,
            "chained_as.session.id": session.id,
            "session.tenantId": tenantId,
            "chained_as.endpoint": "callback",
        });

        const config = await this.getChainedAsConfig(tenantId);
        if (!config.upstream) {
            throw new BadRequestException(
                "Upstream OIDC provider not configured",
            );
        }
        const discovery = await this.getUpstreamDiscovery(
            tenantId,
            config.upstream.issuer,
        );
        const callbackUrl = `${this.getChainedAsBaseUrl(tenantId)}/callback`;

        try {
            await this.exchangeUpstreamCode(
                session,
                code,
                config,
                discovery,
                callbackUrl,
            );
        } catch (err) {
            console.log(err);
            this.logger.error("Failed to exchange code at upstream", err);
            session.status = ChainedAsSessionStatus.EXPIRED;
            await this.sessionRepository.save(session);
            return buildAuthorizationErrorRedirect(
                session.redirectUri,
                "server_error",
                "Failed to exchange code with upstream provider",
                session.walletState,
            );
        }

        // Generate our authorization code for the wallet
        const authorizationCode = randomBytes(32).toString("base64url");
        session.status = ChainedAsSessionStatus.AUTHORIZED;
        session.authorizationCode = authorizationCode;
        session.authorizationCodeExpiresAt = new Date(
            Date.now() + this.AUTH_CODE_LIFETIME_SECONDS * 1000,
        );
        await this.sessionRepository.save(session);

        this.logger.debug(
            `Upstream auth completed for session ${session.id}, redirecting to wallet`,
        );

        return buildAuthorizationCodeRedirect(
            session.redirectUri,
            authorizationCode,
            session.walletState,
        );
    }

    /**
     * Build access token payload.
     */
    private buildTokenPayload(
        tenantId: string,
        session: ChainedAsSession,
        tokenLifetime: number,
        jti: string,
        dpopJkt?: string,
    ): Record<string, unknown> {
        const payload = buildAccessTokenPayload({
            issuer: this.getChainedAsBaseUrl(tenantId),
            audience: `${this.settings.publicUrl}/issuers/${tenantId}`,
            session,
            tokenLifetime,
            jti,
            dpopJkt,
        });
        if (session.upstreamIdTokenClaims) {
            payload.upstream_sub = session.upstreamIdTokenClaims.sub;
            payload.upstream_iss = session.upstreamIdTokenClaims.iss;
        }
        return payload;
    }

    /**
     * Handle the token endpoint.
     * Exchanges the authorization code for an access token.
     */
    async handleToken(
        tenantId: string,
        request: ChainedAsTokenRequestDto,
        dpopJwt?: string,
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<ChainedAsTokenResponseDto> {
        const config = await this.getChainedAsConfig(tenantId);

        if (
            request.grant_type !== "authorization_code" &&
            request.grant_type !== "refresh_token"
        ) {
            throw new BadRequestException(
                'Invalid grant_type, must be "authorization_code" or "refresh_token"',
            );
        }

        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const chainedAsUrl = this.getChainedAsBaseUrl(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            config,
        );
        await this.walletAttestationService.verifyWalletAttestation(
            tenantId,
            clientAttestation,
            chainedAsUrl,
            walletAttestationPolicy.walletAttestationRequired,
            walletAttestationPolicy.walletProviderTrustLists,
        );

        const session = await resolveSessionForTokenRequest(
            this.sessionRepository,
            tenantId,
            request,
            refreshTokenPolicy(config.token),
        );

        // Add session context to span for trace correlation
        this.traceService.getSpan()?.setAttributes({
            "session.id": session.issuerState,
            "chained_as.session.id": session.id,
            "session.tenantId": tenantId,
            "chained_as.endpoint": "token",
        });

        await assertTokenRequestSessionValid(
            this.sessionRepository,
            session,
            request,
        );

        const { tokenType, dpopJkt } = resolveTokenBinding(
            config.requireDPoP,
            session,
            dpopJwt,
        );

        const tokenLifetime = config.token?.lifetimeSeconds || 3600;
        const jti = v4();
        const tokenPayload = this.buildTokenPayload(
            tenantId,
            session,
            tokenLifetime,
            jti,
            dpopJkt,
        );

        // Get the key ID to use - either from config or resolve from key service
        const signingKeyId =
            config.token?.signingKeyId ||
            (await this.keyChainService.getKid(tenantId));

        const publicKey = await this.keyChainService.getPublicKey(
            "jwk",
            tenantId,
            signingKeyId,
        );

        // Use the resolved signing key ID as the kid in the JWT header
        const kid = (publicKey as { kid?: string }).kid || signingKeyId;

        const accessToken = await this.keyChainService.signJWT(
            tokenPayload as any,
            { alg: "ES256", kid, typ: "at+jwt" },
            tenantId,
            signingKeyId,
        );

        session.status = ChainedAsSessionStatus.TOKEN_ISSUED;
        session.accessTokenJti = jti;
        const refreshToken = issueRefreshTokenIfEnabled(
            session,
            config.token,
            request.grant_type,
        );
        retainSessionForIssuedTokens(
            session,
            new Date(Date.now() + tokenLifetime * 1000),
        );

        await this.sessionRepository.save(session);

        return {
            access_token: accessToken,
            token_type: tokenType,
            expires_in: tokenLifetime,
            scope: session.scope,
            // Only include authorization_details if it's a non-empty array
            ...(Array.isArray(session.authorizationDetails) &&
                session.authorizationDetails.length > 0 && {
                    authorization_details: session.authorizationDetails,
                }),
            ...(refreshToken && { refresh_token: refreshToken }),
        };
    }

    /**
     * Get the JWKS for token verification.
     */
    async getJwks(
        tenantId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        const config = await this.getChainedAsConfig(tenantId);

        // Get the key ID to use - either from config or resolve from key service
        const signingKeyId =
            config.token?.signingKeyId ||
            (await this.keyChainService.getKid(tenantId));

        const publicKey = await this.keyChainService.getPublicKey(
            "jwk",
            tenantId,
            signingKeyId,
        );

        return buildJwksResponse(
            publicKey as { kid?: string; [key: string]: unknown },
            signingKeyId,
        );
    }

    /**
     * Get authorization server metadata for the Chained AS.
     */
    async getMetadata(tenantId: string): Promise<Record<string, unknown>> {
        const config = await this.getChainedAsConfig(tenantId);
        const baseUrl = this.getChainedAsBaseUrl(tenantId);
        const publicUrl = this.settings.publicUrl;
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            config,
        );
        const refreshTokensEnabled = refreshTokenPolicy(config.token).enabled;

        return buildAuthorizationServerMetadata({
            issuer: baseUrl,
            authorizationEndpoint: `${baseUrl}/authorize`,
            tokenEndpoint: `${baseUrl}/token`,
            pushedAuthorizationRequestEndpoint: `${baseUrl}/par`,
            jwksUri: `${publicUrl}/.well-known/jwks.json/issuers/${tenantId}/chained-as`,
            grantTypesSupported: refreshTokensEnabled
                ? ["authorization_code", "refresh_token"]
                : ["authorization_code"],
            dpopSigningAlgValuesSupported:
                DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
            ...buildWalletAttestationMetadata(
                walletAttestationPolicy.walletAttestationRequired,
            ),
        });
    }

    /**
     * Get upstream identity claims by issuer state.
     * Used to retrieve the upstream OIDC provider's claims for webhook calls.
     *
     * @param tenantId Tenant of the issuance session
     * @param issuerState The issuer_state from the credential offer session
     * @returns Upstream identity with issuer, subject, and all token claims, or undefined if not found
     */
    async getUpstreamIdentityByIssuerState(
        tenantId: string,
        issuerState: string,
    ): Promise<AuthorizationIdentity | undefined> {
        const chainedSession = await this.sessionRepository.findByIssuerState(
            tenantId,
            issuerState,
        );

        if (
            !chainedSession?.upstreamIdTokenClaims &&
            !chainedSession?.upstreamAccessTokenClaims
        ) {
            return undefined;
        }

        // Combine ID token and access token claims, preferring ID token for identity
        const idClaims = chainedSession.upstreamIdTokenClaims ?? {};
        const accessClaims = chainedSession.upstreamAccessTokenClaims ?? {};

        return {
            iss: (idClaims.iss as string) ?? (accessClaims.iss as string) ?? "",
            sub: (idClaims.sub as string) ?? (accessClaims.sub as string) ?? "",
            token_claims: {
                ...accessClaims,
                ...idClaims, // ID token claims take precedence
            },
        };
    }
}
