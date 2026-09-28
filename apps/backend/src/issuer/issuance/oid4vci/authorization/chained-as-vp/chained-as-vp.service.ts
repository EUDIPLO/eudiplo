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
import { GetSessionForTenant } from "../../../../../session/application/get-session-for-tenant.js";
import { UpdateSessionForTenant } from "../../../../../session/application/update-session-for-tenant.js";
import { SessionStatus } from "../../../../../session/domain/session-state.js";
import { WalletAttestationService } from "../../../../../trust/wallet-attestation.service.js";
import { Oid4vpService } from "../../../../../verifier/oid4vp/oid4vp.service.js";
import type { ChainedAsConfig } from "../../../../configuration/issuance/dto/chained-as-config.dto.js";
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

@Injectable()
export class ChainedAsVpService {
    private readonly logger = new Logger(ChainedAsVpService.name);
    private readonly REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";
    private readonly SESSION_LIFETIME_SECONDS = 600;
    private readonly AUTH_CODE_LIFETIME_SECONDS = 300;

    constructor(
        private readonly configService: ConfigService,
        private readonly keyChainService: KeyChainService,
        private readonly createSession: CreateSession,
        private readonly updateSessionForTenant: UpdateSessionForTenant,
        private readonly getSessionForTenant: GetSessionForTenant,
        private readonly issuanceService: IssuanceService,
        private readonly walletAttestationService: WalletAttestationService,
        private readonly traceService: TraceService,
        private readonly oid4vpService: Oid4vpService,
        @InjectRepository(ChainedAsSessionEntity)
        private readonly sessionRepository: Repository<ChainedAsSessionEntity>,
    ) {}

    private getChainedAsVpBaseUrl(tenantId: string): string {
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");
        return `${publicUrl}/issuers/${tenantId}/chained-as-vp`;
    }

    async getChainedAsVpConfig(tenantId: string): Promise<ChainedAsConfig> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        const chainedServer = (issuanceConfig.authorizationServers ?? []).find(
            (server) =>
                server.enabled !== false &&
                server.type === "chained" &&
                (server as { vp?: { enabled?: boolean } }).vp?.enabled,
        );

        if (!chainedServer) {
            throw new NotFoundException(
                "VP-backed Chained Authorization Server is not enabled for this tenant",
            );
        }

        return chainedServer as unknown as ChainedAsConfig;
    }

    async handlePar(
        tenantId: string,
        request: ChainedAsParRequestDto,
        dpopJkt?: string,
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<ChainedAsParResponseDto> {
        const config = await this.getChainedAsVpConfig(tenantId);
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
            this.getChainedAsVpBaseUrl(tenantId),
            walletAttestationPolicy.walletAttestationRequired,
            walletAttestationPolicy.walletProviderTrustLists,
        );

        let issuerState = request.issuer_state;
        if (issuerState) {
            try {
                await this.getSessionForTenant.execute(tenantId, issuerState);
            } catch {
                throw new BadRequestException("Invalid issuer_state");
            }
        } else {
            issuerState = v4();
        }

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

        this.traceService.getSpan()?.setAttributes({
            "session.id": issuerState,
            "chained_as_vp.session.id": sessionId,
            "session.tenantId": tenantId,
            "chained_as_vp.endpoint": "par",
        });

        return {
            request_uri: `${this.REQUEST_URI_PREFIX}${sessionId}`,
            expires_in: this.SESSION_LIFETIME_SECONDS,
        };
    }

    async handleAuthorize(
        tenantId: string,
        clientId: string,
        requestUri: string,
        origin?: string,
    ): Promise<string> {
        const config = await this.getChainedAsVpConfig(tenantId);

        if (!config.vp?.presentationConfigId) {
            throw new BadRequestException(
                "Presentation configuration is not configured",
            );
        }

        if (!requestUri.startsWith(this.REQUEST_URI_PREFIX)) {
            throw new BadRequestException("Invalid request_uri format");
        }

        const sessionId = requestUri.slice(this.REQUEST_URI_PREFIX.length);
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
            "chained_as_vp.session.id": session.id,
            "session.tenantId": tenantId,
            "chained_as_vp.endpoint": "authorize",
        });

        const callbackUrl = `${this.getChainedAsVpBaseUrl(tenantId)}/vp-callback?cas=${encodeURIComponent(session.id)}`;
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");

        await this.createSession.execute({
            id: session.id,
            tenantId,
            requestId: config.vp.presentationConfigId,
            redirectUri: callbackUrl,
        });

        const offer = await this.oid4vpService.createRequest(
            config.vp.presentationConfigId,
            {
                session: session.id,
                redirectUri: callbackUrl,
            },
            tenantId,
            false,
            origin || publicUrl,
        );

        this.logger.debug(
            `Redirecting session ${session.id} to OID4VP wallet invocation`,
        );

        return `openid4vp://?${offer.uri}`;
    }

    async handleVerifierCallback(
        tenantId: string,
        chainedAsSessionId: string,
        responseCode?: string,
        error?: string,
        errorDescription?: string,
    ): Promise<string> {
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

        const verifierSession = await this.getSessionForTenant.execute(
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
            await this.updateSessionForTenant.execute(
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
            Date.now() + this.AUTH_CODE_LIFETIME_SECONDS * 1000,
        );
        await this.sessionRepository.save(session);

        return buildAuthorizationCodeRedirect(
            session.redirectUri,
            authorizationCode,
            session.walletState,
            this.getChainedAsVpBaseUrl(tenantId),
        );
    }

    async handleToken(
        tenantId: string,
        request: ChainedAsTokenRequestDto,
        dpopJwt?: string,
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<ChainedAsTokenResponseDto> {
        const config = await this.getChainedAsVpConfig(tenantId);

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
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            config,
        );
        await this.walletAttestationService.verifyWalletAttestation(
            tenantId,
            clientAttestation,
            this.getChainedAsVpBaseUrl(tenantId),
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
            issuer: this.getChainedAsVpBaseUrl(tenantId),
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

    async getJwks(
        tenantId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        const config = await this.getChainedAsVpConfig(tenantId);
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

    async getMetadata(tenantId: string): Promise<Record<string, unknown>> {
        const config = await this.getChainedAsVpConfig(tenantId);
        const baseUrl = this.getChainedAsVpBaseUrl(tenantId);
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
            jwksUri: `${publicUrl}/.well-known/jwks.json/issuers/${tenantId}/chained-as-vp`,
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
}
