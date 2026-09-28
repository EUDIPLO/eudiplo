import { randomBytes } from "node:crypto";
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { TraceService } from "nestjs-otel";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { KeyChainService } from "../../../../../crypto/key/key-chain.service.js";
import { CreateSession } from "../../../../../session/application/create-session.js";
import { SessionStore } from "../../../../../session/application/session-store.js";
import { SessionStatus } from "../../../../../session/domain/session-state.js";
import { WalletAttestationService } from "../../../../../trust/wallet-attestation.service.js";
import { Oid4vpService } from "../../../../../verifier/oid4vp/oid4vp.service.js";
import type { TrustListRef } from "../../../../../verifier/presentations/entities/presentation-config.entity.js";
import { ManagedAuthorizationServerConfig } from "../../../../configuration/issuance/dto/authorization-server-config.dto.js";
import { ChainedAsTokenConfig } from "../../../../configuration/issuance/dto/chained-as-config.dto.js";
import { IssuanceService } from "../../../../configuration/issuance/issuance.service.js";
import {
    assertTokenRequestSessionValid,
    buildAccessTokenPayload,
    buildAuthorizationCodeRedirect,
    buildAuthorizationErrorRedirect,
    buildAuthorizationServerMetadata,
    buildJwksResponse,
    buildWalletAttestationMetadata,
    ChainedAsParRequestDto,
    ChainedAsParResponseDto,
    ChainedAsSessionEntity,
    ChainedAsSessionStatus,
    ChainedAsTokenRequestDto,
    ChainedAsTokenResponseDto,
    DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
    issueRefreshTokenIfEnabled,
    resolveSessionForTokenRequest,
    resolveTokenBinding,
    resolveWalletAttestationPolicy,
} from "../shared/index.js";

type Oid4VpManagedAuthorizationServerConfig =
    ManagedAuthorizationServerConfig & {
        type: "oid4vp";
        id: string;
        presentationConfigId: string;
        token?: ChainedAsTokenConfig;
        requireDPoP?: boolean;
        walletAttestationRequired?: boolean;
        walletProviderTrustLists?: TrustListRef[];
    };

type ExternalManagedAuthorizationServerConfig =
    ManagedAuthorizationServerConfig & {
        type: "external";
        issuer: string;
    };

type ChainedManagedAuthorizationServerConfig =
    ManagedAuthorizationServerConfig & {
        type: "chained";
        upstream: unknown;
    };

@Injectable()
export class AuthorizationServersService {
    private readonly logger = new Logger(AuthorizationServersService.name);
    private readonly requestUriPrefix = "urn:ietf:params:oauth:request_uri:";
    private readonly sessionLifetimeSeconds = 600;
    private readonly authCodeLifetimeSeconds = 300;

    constructor(
        private readonly configService: ConfigService,
        private readonly keyChainService: KeyChainService,
        private readonly createSession: CreateSession,
        private readonly sessionStore: SessionStore,
        private readonly issuanceService: IssuanceService,
        private readonly walletAttestationService: WalletAttestationService,
        private readonly traceService: TraceService,
        private readonly oid4vpService: Oid4vpService,
        @InjectRepository(ChainedAsSessionEntity)
        private readonly sessionRepository: Repository<ChainedAsSessionEntity>,
    ) {}

    getAuthorizationServerBaseUrl(
        tenantId: string,
        authorizationServerId: string,
    ): string {
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");
        return `${publicUrl}/issuers/${tenantId}/authorization-servers/${authorizationServerId}`;
    }

    async getEnabledAuthorizationServers(
        tenantId: string,
    ): Promise<Oid4VpManagedAuthorizationServerConfig[]> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        return (issuanceConfig.authorizationServers ?? []).filter(
            (config): config is Oid4VpManagedAuthorizationServerConfig => {
                const candidate =
                    config as Partial<Oid4VpManagedAuthorizationServerConfig>;
                return (
                    config.enabled !== false &&
                    config.type === "oid4vp" &&
                    typeof candidate.id === "string" &&
                    candidate.id.length > 0 &&
                    typeof candidate.presentationConfigId === "string" &&
                    candidate.presentationConfigId.length > 0
                );
            },
        );
    }

    async getExternalAuthorizationServerUrls(
        tenantId: string,
    ): Promise<string[]> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        return (issuanceConfig.authorizationServers ?? [])
            .filter(
                (
                    config,
                ): config is ExternalManagedAuthorizationServerConfig => {
                    const candidate =
                        config as Partial<ExternalManagedAuthorizationServerConfig>;
                    return (
                        config.enabled !== false &&
                        config.type === "external" &&
                        typeof candidate.issuer === "string" &&
                        candidate.issuer.length > 0
                    );
                },
            )
            .map((config) => config.issuer)
            .filter((url, index, arr) => arr.indexOf(url) === index);
    }

    async hasEnabledChainedAuthorizationServer(
        tenantId: string,
    ): Promise<boolean> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        return (issuanceConfig.authorizationServers ?? []).some(
            (config): config is ChainedManagedAuthorizationServerConfig => {
                const candidate =
                    config as Partial<ChainedManagedAuthorizationServerConfig>;
                return (
                    config.enabled !== false &&
                    config.type === "chained" &&
                    !!candidate.upstream
                );
            },
        );
    }

    async getAuthorizationServerConfig(
        tenantId: string,
        authorizationServerId: string,
    ): Promise<Oid4VpManagedAuthorizationServerConfig> {
        const config = (
            await this.getEnabledAuthorizationServers(tenantId)
        ).find((entry) => entry.id === authorizationServerId);

        if (!config) {
            throw new NotFoundException(
                `Authorization server '${authorizationServerId}' is not configured for this tenant`,
            );
        }

        return config;
    }

    async getAuthorizationServerIssuerUrls(
        tenantId: string,
    ): Promise<string[]> {
        const configs = await this.getEnabledAuthorizationServers(tenantId);
        return configs.map((config) =>
            this.getAuthorizationServerBaseUrl(tenantId, config.id),
        );
    }

    async getDefaultAuthorizationServerUrl(
        tenantId: string,
        preferredAuthorizationServerId?: string,
    ): Promise<string | undefined> {
        if (preferredAuthorizationServerId) {
            await this.getAuthorizationServerConfig(
                tenantId,
                preferredAuthorizationServerId,
            );
            return this.getAuthorizationServerBaseUrl(
                tenantId,
                preferredAuthorizationServerId,
            );
        }

        const configs = await this.getEnabledAuthorizationServers(tenantId);
        const first = configs[0];
        if (!first) {
            return undefined;
        }

        return this.getAuthorizationServerBaseUrl(tenantId, first.id);
    }

    async handlePar(
        tenantId: string,
        authorizationServerId: string,
        request: ChainedAsParRequestDto,
        dpopJkt?: string,
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<ChainedAsParResponseDto> {
        const config = await this.getAuthorizationServerConfig(
            tenantId,
            authorizationServerId,
        );
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        if (request.response_type !== "code") {
            throw new BadRequestException(
                'Invalid response_type, must be "code"',
            );
        }

        if (config.requireDPoP && !dpopJkt) {
            throw new BadRequestException("DPoP is required");
        }

        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            config,
        );

        await this.walletAttestationService.verifyWalletAttestation(
            tenantId,
            clientAttestation,
            this.getAuthorizationServerBaseUrl(tenantId, authorizationServerId),
            walletAttestationPolicy.walletAttestationRequired,
            walletAttestationPolicy.walletProviderTrustLists,
        );

        let issuerState = request.issuer_state;
        if (issuerState) {
            try {
                await this.sessionStore.getForTenant(tenantId, issuerState);
            } catch {
                throw new BadRequestException("Invalid issuer_state");
            }
        } else {
            issuerState = v4();
        }

        const sessionId = v4();
        const expiresAt = new Date(
            Date.now() + this.sessionLifetimeSeconds * 1000,
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
            vpPresentationConfigId: config.presentationConfigId,
        });

        await this.sessionRepository.save(session);

        this.traceService.getSpan()?.setAttributes({
            "session.id": issuerState,
            "authorization_server.session.id": sessionId,
            "session.tenantId": tenantId,
            "authorization_server.id": authorizationServerId,
            "authorization_server.endpoint": "par",
        });

        return {
            request_uri: `${this.requestUriPrefix}${sessionId}`,
            expires_in: this.sessionLifetimeSeconds,
        };
    }

    async handleAuthorize(
        tenantId: string,
        authorizationServerId: string,
        clientId: string,
        requestUri: string,
        origin?: string,
    ): Promise<string> {
        const config = await this.getAuthorizationServerConfig(
            tenantId,
            authorizationServerId,
        );

        if (!requestUri.startsWith(this.requestUriPrefix)) {
            throw new BadRequestException("Invalid request_uri format");
        }

        const sessionId = requestUri.slice(this.requestUriPrefix.length);
        const session = await this.sessionRepository.findOne({
            where: {
                id: sessionId,
                tenantId,
                status: ChainedAsSessionStatus.PENDING_AUTHORIZE,
            },
        });

        if (!session) {
            throw new BadRequestException("Invalid or expired request_uri");
        }

        if (session.clientId !== clientId) {
            throw new BadRequestException("Client ID mismatch");
        }

        if (session.expiresAt < new Date()) {
            session.status = ChainedAsSessionStatus.EXPIRED;
            await this.sessionRepository.save(session);
            throw new BadRequestException("Session expired");
        }

        session.status = ChainedAsSessionStatus.PENDING_VP_CALLBACK;
        await this.sessionRepository.save(session);

        this.traceService.getSpan()?.setAttributes({
            "session.id": session.issuerState,
            "authorization_server.session.id": session.id,
            "session.tenantId": tenantId,
            "authorization_server.id": authorizationServerId,
            "authorization_server.endpoint": "authorize",
        });

        const callbackUrl = `${this.getAuthorizationServerBaseUrl(tenantId, authorizationServerId)}/vp-callback?cas=${encodeURIComponent(session.id)}`;

        await this.createSession.execute({
            id: session.id,
            tenantId,
            requestId: config.presentationConfigId,
            redirectUri: callbackUrl,
        });

        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");
        const offer = await this.oid4vpService.createRequest(
            config.presentationConfigId,
            {
                session: session.id,
                redirectUri: callbackUrl,
            },
            tenantId,
            false,
            origin || publicUrl,
        );

        this.logger.debug(
            `Redirecting session ${session.id} to OID4VP wallet invocation for ${authorizationServerId}`,
        );

        return `openid4vp://?${offer.uri}`;
    }

    async handleVerifierCallback(
        tenantId: string,
        authorizationServerId: string,
        chainedAsSessionId: string,
        responseCode?: string,
        error?: string,
        errorDescription?: string,
    ): Promise<string> {
        await this.getAuthorizationServerConfig(
            tenantId,
            authorizationServerId,
        );

        const session = await this.sessionRepository.findOne({
            where: {
                id: chainedAsSessionId,
                tenantId,
                status: ChainedAsSessionStatus.PENDING_VP_CALLBACK,
            },
        });

        if (!session) {
            throw new BadRequestException(
                "Invalid or expired callback session",
            );
        }

        if (error) {
            session.status = ChainedAsSessionStatus.EXPIRED;
            await this.sessionRepository.save(session);
            return buildAuthorizationErrorRedirect(
                session.redirectUri,
                error,
                errorDescription,
                session.walletState,
            );
        }

        const verifierSession = await this.sessionStore.getForTenant(
            session.tenantId,
            session.id,
        );
        if (
            verifierSession.status !== SessionStatus.Completed ||
            !responseCode ||
            verifierSession.responseCode !== responseCode
        ) {
            session.status = ChainedAsSessionStatus.EXPIRED;
            await this.sessionRepository.save(session);
            return buildAuthorizationErrorRedirect(
                session.redirectUri,
                "invalid_request",
                "OID4VP verification did not complete successfully",
                session.walletState,
            );
        }

        if (session.issuerState && verifierSession.credentials) {
            await this.sessionStore.updateForTenant(
                session.tenantId,
                session.issuerState,
                {
                    credentials: verifierSession.credentials as any,
                },
            );
        }

        const authorizationCode = randomBytes(32).toString("base64url");
        session.status = ChainedAsSessionStatus.AUTHORIZED;
        session.authorizationCode = authorizationCode;
        session.authorizationCodeExpiresAt = new Date(
            Date.now() + this.authCodeLifetimeSeconds * 1000,
        );
        session.vpResponseCode = responseCode;
        await this.sessionRepository.save(session);

        return buildAuthorizationCodeRedirect(
            session.redirectUri,
            authorizationCode,
            session.walletState,
            this.getAuthorizationServerBaseUrl(tenantId, authorizationServerId),
        );
    }

    async handleToken(
        tenantId: string,
        authorizationServerId: string,
        request: ChainedAsTokenRequestDto,
        dpopJwt?: string,
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<ChainedAsTokenResponseDto> {
        const config = await this.getAuthorizationServerConfig(
            tenantId,
            authorizationServerId,
        );
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        if (
            request.grant_type !== "authorization_code" &&
            request.grant_type !== "refresh_token"
        ) {
            throw new BadRequestException(
                'Invalid grant_type, must be "authorization_code" or "refresh_token"',
            );
        }

        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            config,
        );
        await this.walletAttestationService.verifyWalletAttestation(
            tenantId,
            clientAttestation,
            this.getAuthorizationServerBaseUrl(tenantId, authorizationServerId),
            walletAttestationPolicy.walletAttestationRequired,
            walletAttestationPolicy.walletProviderTrustLists,
        );

        const session = await resolveSessionForTokenRequest(
            this.sessionRepository,
            tenantId,
            request,
        );
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
        const tokenPayload = buildAccessTokenPayload({
            issuer: this.getAuthorizationServerBaseUrl(
                tenantId,
                authorizationServerId,
            ),
            audience: `${this.configService.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenantId}`,
            session,
            tokenLifetime,
            jti,
            dpopJkt,
        });

        const signingKeyId =
            config.token?.signingKeyId ||
            (await this.keyChainService.getKid(tenantId));
        const publicKey = await this.keyChainService.getPublicKey(
            "jwk",
            tenantId,
            signingKeyId,
        );
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
            config.token ?? {},
        );

        await this.sessionRepository.save(session);

        return {
            access_token: accessToken,
            token_type: tokenType,
            expires_in: tokenLifetime,
            scope: session.scope,
            ...(Array.isArray(session.authorizationDetails) &&
                session.authorizationDetails.length > 0 && {
                    authorization_details: session.authorizationDetails,
                }),
            ...(refreshToken && { refresh_token: refreshToken }),
        };
    }

    async getMetadata(
        tenantId: string,
        authorizationServerId: string,
    ): Promise<Record<string, unknown>> {
        const config = await this.getAuthorizationServerConfig(
            tenantId,
            authorizationServerId,
        );
        const baseUrl = this.getAuthorizationServerBaseUrl(
            tenantId,
            authorizationServerId,
        );
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            config,
        );
        const refreshTokensEnabled = config.token?.refreshTokenEnabled ?? true;

        return buildAuthorizationServerMetadata({
            issuer: baseUrl,
            authorizationEndpoint: `${baseUrl}/authorize`,
            tokenEndpoint: `${baseUrl}/token`,
            pushedAuthorizationRequestEndpoint: `${baseUrl}/par`,
            jwksUri: `${publicUrl}/.well-known/jwks.json/issuers/${tenantId}/authorization-servers/${authorizationServerId}`,
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

    async getJwks(
        tenantId: string,
        authorizationServerId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        const config = await this.getAuthorizationServerConfig(
            tenantId,
            authorizationServerId,
        );
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
}
