import { HttpModule, HttpService } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { CryptoModule } from "../../../../crypto/crypto.module.js";
import { CryptoService } from "../../../../crypto/crypto.service.js";
import { KeyChainService } from "../../../../crypto/key/key-chain.service.js";
import { CreateSession } from "../../../../session/application/create-session.js";
import { RecordFailedTxCodeAttempt } from "../../../../session/application/record-failed-tx-code-attempt.js";
import { SessionStore } from "../../../../session/application/session-store.js";
import { SessionModule } from "../../../../session/session.module.js";
import { SessionConfigService } from "../../../../session/session-config.service.js";
import { TrustModule } from "../../../../trust/trust.module.js";
import { WalletAttestationService } from "../../../../trust/wallet-attestation.service.js";
import { Oid4vpModule } from "../../../../verifier/oid4vp/oid4vp.module.js";
import { PresentationsModule } from "../../../../verifier/presentations/presentations.module.js";
import { ConfigurationModule } from "../../../configuration/configuration.module.js";
import { IssuanceService } from "../../../configuration/issuance/issuance.service.js";
import { StatusListConfigService } from "../../../status-list/status-list-config.service.js";
import { CredentialNonceModule } from "../credential-nonce.module.js";
import { DpopProofModule } from "../dpop-proof.module.js";
import { InteractiveAuthSessionEntity } from "../entities/interactive-auth-session.entity.js";
import { OID4VCI_SETTINGS, type Oid4vciSettings } from "../oid4vci-settings.js";
import {
    DPOP_PROOF_REPLAY_REGISTRY,
    type DpopProofReplayRegistry,
} from "../ports/dpop-proof-replay-registry.js";
import {
    ConfiguredBuiltInAuthorizationServerConfiguration,
    CryptoOAuthAuthorizationServerFactory,
    KeyChainAccessTokenSigningKeys,
    WalletAttestationClientVerifier,
} from "./adapters/built-in-authorization-server.adapters.js";
import {
    CHAINED_AS_SESSION_CLEANUP_SETTINGS,
    ChainedAsSessionCleanupJob,
} from "./adapters/chained-as-session-cleanup.job.js";
import { TypeOrmChainedAsSessionRepository } from "./adapters/typeorm-chained-as-session.repository.js";
import { TypeOrmInteractiveAuthSessionRepository } from "./adapters/typeorm-interactive-auth-session.repository.js";
import { AuthorizePushedRequest } from "./application/authorize-pushed-request.js";
import { BuildBuiltInAuthorizationServerMetadata } from "./application/build-built-in-authorization-server-metadata.js";
import { ExchangeAccessToken } from "./application/exchange-access-token.js";
import { PushAuthorizationRequest } from "./application/push-authorization-request.js";
import { AuthorizationServersController } from "./authorization-servers/authorization-servers.controller.js";
import { AuthorizationServersService } from "./authorization-servers/authorization-servers.service.js";
import { AuthorizeController } from "./authorize/authorize.controller.js";
import { AuthorizeService } from "./authorize/authorize.service.js";
import { InteractiveAuthorizationController } from "./authorize/interactive-authorization.controller.js";
import { InteractiveAuthorizationService } from "./authorize/interactive-authorization.service.js";
import { HttpOidcDiscoveryResolver } from "./chained-as/adapters/http-oidc-discovery-resolver.js";
import { HttpOidcTokenExchanger } from "./chained-as/adapters/http-oidc-token-exchanger.js";
import { ChainedAsController } from "./chained-as/chained-as.controller.js";
import { ChainedAsService } from "./chained-as/chained-as.service.js";
import { OIDC_DISCOVERY_RESOLVER } from "./chained-as/ports/oidc-discovery-resolver.js";
import { OIDC_TOKEN_EXCHANGER } from "./chained-as/ports/oidc-token-exchanger.js";
import {
    ACCESS_TOKEN_SIGNING_KEYS,
    type AccessTokenSigningKeys,
} from "./ports/access-token-signing-keys.js";
import {
    BUILT_IN_AUTHORIZATION_SERVER_CONFIGURATION,
    type BuiltInAuthorizationServerConfiguration,
} from "./ports/built-in-authorization-server-configuration.js";
import { CHAINED_AS_SESSION_REPOSITORY } from "./ports/chained-as-session.repository.js";
import {
    CLIENT_ATTESTATION_VERIFIER,
    type ClientAttestationVerifier,
} from "./ports/client-attestation-verifier.js";
import { INTERACTIVE_AUTH_SESSION_REPOSITORY } from "./ports/interactive-auth-session.repository.js";
import {
    OAUTH_AUTHORIZATION_SERVER_FACTORY,
    type OAuthAuthorizationServerFactory,
} from "./ports/oauth-authorization-server-factory.js";
import { ChainedAsSessionEntity } from "./shared/entities/chained-as-session.entity.js";

/** Built-in authorization server: ports, use cases and typed settings. */
export const builtInAuthorizationServerProviders = [
    {
        provide: OID4VCI_SETTINGS,
        inject: [ConfigService],
        useFactory: (config: ConfigService): Oid4vciSettings => ({
            publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
            internalUrl: config.get<string>("INTERNAL_URL"),
        }),
    },
    {
        provide: OAUTH_AUTHORIZATION_SERVER_FACTORY,
        inject: [CryptoService],
        useFactory: (crypto: CryptoService) =>
            new CryptoOAuthAuthorizationServerFactory(crypto),
    },
    {
        provide: BUILT_IN_AUTHORIZATION_SERVER_CONFIGURATION,
        inject: [
            IssuanceService,
            StatusListConfigService,
            SessionConfigService,
        ],
        useFactory: (
            issuance: IssuanceService,
            statusLists: StatusListConfigService,
            sessionConfig: SessionConfigService,
        ) =>
            new ConfiguredBuiltInAuthorizationServerConfiguration(
                issuance,
                statusLists,
                sessionConfig,
            ),
    },
    {
        provide: CLIENT_ATTESTATION_VERIFIER,
        inject: [WalletAttestationService],
        useFactory: (walletAttestation: WalletAttestationService) =>
            new WalletAttestationClientVerifier(walletAttestation),
    },
    {
        provide: ACCESS_TOKEN_SIGNING_KEYS,
        inject: [KeyChainService],
        useFactory: (keyChain: KeyChainService) =>
            new KeyChainAccessTokenSigningKeys(keyChain),
    },
    {
        provide: BuildBuiltInAuthorizationServerMetadata,
        inject: [
            BUILT_IN_AUTHORIZATION_SERVER_CONFIGURATION,
            OAUTH_AUTHORIZATION_SERVER_FACTORY,
            OID4VCI_SETTINGS,
        ],
        useFactory: (
            configuration: BuiltInAuthorizationServerConfiguration,
            servers: OAuthAuthorizationServerFactory,
            settings: Oid4vciSettings,
        ) =>
            new BuildBuiltInAuthorizationServerMetadata(
                configuration,
                servers,
                settings,
            ),
    },
    {
        provide: ExchangeAccessToken,
        inject: [
            OAUTH_AUTHORIZATION_SERVER_FACTORY,
            SessionStore,
            RecordFailedTxCodeAttempt,
            BUILT_IN_AUTHORIZATION_SERVER_CONFIGURATION,
            BuildBuiltInAuthorizationServerMetadata,
            CLIENT_ATTESTATION_VERIFIER,
            ACCESS_TOKEN_SIGNING_KEYS,
            OID4VCI_SETTINGS,
            DPOP_PROOF_REPLAY_REGISTRY,
        ],
        useFactory: (
            servers: OAuthAuthorizationServerFactory,
            sessions: SessionStore,
            txCodeAttempts: RecordFailedTxCodeAttempt,
            configuration: BuiltInAuthorizationServerConfiguration,
            metadata: BuildBuiltInAuthorizationServerMetadata,
            clientAttestation: ClientAttestationVerifier,
            signingKeys: AccessTokenSigningKeys,
            settings: Oid4vciSettings,
            dpopProofs: DpopProofReplayRegistry,
        ) =>
            new ExchangeAccessToken(
                servers,
                sessions,
                txCodeAttempts,
                configuration,
                metadata,
                clientAttestation,
                signingKeys,
                settings,
                dpopProofs,
            ),
    },
    {
        provide: PushAuthorizationRequest,
        inject: [
            OAUTH_AUTHORIZATION_SERVER_FACTORY,
            SessionStore,
            CreateSession,
            BUILT_IN_AUTHORIZATION_SERVER_CONFIGURATION,
            BuildBuiltInAuthorizationServerMetadata,
            CLIENT_ATTESTATION_VERIFIER,
            DPOP_PROOF_REPLAY_REGISTRY,
        ],
        useFactory: (
            servers: OAuthAuthorizationServerFactory,
            sessions: SessionStore,
            createSession: CreateSession,
            configuration: BuiltInAuthorizationServerConfiguration,
            metadata: BuildBuiltInAuthorizationServerMetadata,
            clientAttestation: ClientAttestationVerifier,
            dpopProofs: DpopProofReplayRegistry,
        ) =>
            new PushAuthorizationRequest(
                servers,
                sessions,
                createSession,
                configuration,
                metadata,
                clientAttestation,
                dpopProofs,
            ),
    },
    {
        provide: AuthorizePushedRequest,
        inject: [SessionStore, OID4VCI_SETTINGS],
        useFactory: (sessions: SessionStore, settings: Oid4vciSettings) =>
            new AuthorizePushedRequest(sessions, settings),
    },
];

/**
 * Authorization Module - Groups the OID4VCI authorization server implementations.
 *
 * Bundles the three authorization-server variants and their shared logic:
 * - `authorize` — the issuer-native OAuth 2.0 / OID4VCI authorization server
 *   (authorization code, pre-authorized code, refresh token, interactive auth).
 * - `authorization-servers` — managed OID4VP-backed authorization servers.
 * - `chained-as` — chained authorization server delegating to an upstream OIDC provider.
 *
 * The authorization-server services are exported so the surrounding issuance
 * components (e.g. metadata and well-known endpoints) can consume them.
 */
@Module({
    imports: [
        CryptoModule,
        ConfigurationModule,
        Oid4vpModule,
        PresentationsModule,
        SessionModule,
        CredentialNonceModule,
        DpopProofModule,
        HttpModule,
        TrustModule,
        TypeOrmModule.forFeature([
            InteractiveAuthSessionEntity,
            ChainedAsSessionEntity,
        ]),
    ],
    controllers: [
        AuthorizeController,
        InteractiveAuthorizationController,
        ChainedAsController,
        AuthorizationServersController,
    ],
    providers: [
        ...builtInAuthorizationServerProviders,
        {
            provide: INTERACTIVE_AUTH_SESSION_REPOSITORY,
            inject: [getRepositoryToken(InteractiveAuthSessionEntity)],
            useFactory: (
                repository: Repository<InteractiveAuthSessionEntity>,
            ) => new TypeOrmInteractiveAuthSessionRepository(repository),
        },
        {
            provide: CHAINED_AS_SESSION_REPOSITORY,
            inject: [getRepositoryToken(ChainedAsSessionEntity)],
            useFactory: (repository: Repository<ChainedAsSessionEntity>) =>
                new TypeOrmChainedAsSessionRepository(repository),
        },
        ChainedAsSessionCleanupJob,
        {
            provide: CHAINED_AS_SESSION_CLEANUP_SETTINGS,
            inject: [ConfigService],
            // Runs on the session tidy-up interval.
            useFactory: (config: ConfigService) => ({
                cleanupIntervalMs:
                    config.getOrThrow<number>("SESSION_TIDY_UP_INTERVAL") *
                    1000,
            }),
        },
        AuthorizeService,
        InteractiveAuthorizationService,
        ChainedAsService,
        {
            provide: OIDC_DISCOVERY_RESOLVER,
            inject: [HttpService],
            useFactory: (http: HttpService) =>
                new HttpOidcDiscoveryResolver(http),
        },
        {
            provide: OIDC_TOKEN_EXCHANGER,
            inject: [HttpService],
            useFactory: (http: HttpService) => new HttpOidcTokenExchanger(http),
        },
        AuthorizationServersService,
    ],
    exports: [
        OID4VCI_SETTINGS,
        AuthorizeService,
        InteractiveAuthorizationService,
        ChainedAsService,
        AuthorizationServersService,
    ],
})
export class AuthorizationModule {}
