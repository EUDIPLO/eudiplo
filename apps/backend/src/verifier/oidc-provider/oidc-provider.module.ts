import { hkdfSync } from "node:crypto";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { SessionStore } from "../../session/application/session-store.js";
import { SessionModule } from "../../session/session.module.js";
import { Oid4vpModule } from "../oid4vp/oid4vp.module.js";
import { Oid4vpService } from "../oid4vp/oid4vp.service.js";
import { PresentationConfigService } from "../presentations/configuration/presentation-config.service.js";
import { PresentationsModule } from "../presentations/presentations.module.js";
import { KeyChainIdTokenSigner } from "./adapters/key-chain-id-token-signer.js";
import { Oid4vpSignInPresentation } from "./adapters/oid4vp-sign-in-presentation.js";
import { OidcSignInCleanupJob } from "./adapters/oidc-sign-in-cleanup.job.js";
import { TypeOrmOidcClientRepository } from "./adapters/typeorm-oidc-client.repository.js";
import { TypeOrmOidcSignInRepository } from "./adapters/typeorm-oidc-sign-in.repository.js";
import { AuthenticateOidcClient } from "./application/authenticate-client.js";
import { BuildOidcDiscovery } from "./application/build-oidc-discovery.js";
import { FinishSignIn } from "./application/finish-sign-in.js";
import { PushAuthorizationRequest } from "./application/push-authorization-request.js";
import { RedeemAuthorizationCode } from "./application/redeem-authorization-code.js";
import { StartSignIn } from "./application/start-sign-in.js";
import { OidcClientEntity } from "./entities/oidc-client.entity.js";
import { OidcSignInEntity } from "./entities/oidc-sign-in.entity.js";
import { OidcClientController } from "./oidc-client.controller.js";
import { OidcClientService } from "./oidc-client.service.js";
import { OidcProviderController } from "./oidc-provider.controller.js";
import {
    OIDC_PROVIDER_SETTINGS,
    type OidcProviderSettings,
} from "./oidc-provider-settings.js";
import {
    ID_TOKEN_SIGNER,
    type IdTokenSigner,
} from "./ports/id-token-signer.js";
import {
    OIDC_CLIENT_REPOSITORY,
    type OidcClientRepository,
} from "./ports/oidc-client.repository.js";
import {
    OIDC_SIGN_IN_REPOSITORY,
    type OidcSignInRepository,
} from "./ports/oidc-sign-in.repository.js";
import {
    SIGN_IN_PRESENTATION,
    type SignInPresentation,
} from "./ports/sign-in-presentation.js";

/** Use cases of the provider, built from the ports and settings. */
const useCaseProviders = [
    {
        provide: BuildOidcDiscovery,
        inject: [
            OIDC_CLIENT_REPOSITORY,
            ID_TOKEN_SIGNER,
            OIDC_PROVIDER_SETTINGS,
        ],
        useFactory: (
            clients: OidcClientRepository,
            signer: IdTokenSigner,
            settings: OidcProviderSettings,
        ) => new BuildOidcDiscovery(clients, signer, settings.publicUrl),
    },
    {
        provide: AuthenticateOidcClient,
        inject: [OIDC_CLIENT_REPOSITORY],
        useFactory: (clients: OidcClientRepository) =>
            new AuthenticateOidcClient(clients),
    },
    {
        provide: PushAuthorizationRequest,
        inject: [OIDC_SIGN_IN_REPOSITORY, SIGN_IN_PRESENTATION],
        useFactory: (
            signIns: OidcSignInRepository,
            presentations: SignInPresentation,
        ) => new PushAuthorizationRequest(signIns, presentations),
    },
    {
        provide: StartSignIn,
        inject: [
            OIDC_CLIENT_REPOSITORY,
            OIDC_SIGN_IN_REPOSITORY,
            SIGN_IN_PRESENTATION,
            OIDC_PROVIDER_SETTINGS,
        ],
        useFactory: (
            clients: OidcClientRepository,
            signIns: OidcSignInRepository,
            presentations: SignInPresentation,
            settings: OidcProviderSettings,
        ) =>
            new StartSignIn(
                clients,
                signIns,
                presentations,
                settings.publicUrl,
            ),
    },
    {
        provide: FinishSignIn,
        inject: [
            OIDC_SIGN_IN_REPOSITORY,
            SIGN_IN_PRESENTATION,
            OIDC_CLIENT_REPOSITORY,
            OIDC_PROVIDER_SETTINGS,
        ],
        useFactory: (
            signIns: OidcSignInRepository,
            presentations: SignInPresentation,
            clients: OidcClientRepository,
            settings: OidcProviderSettings,
        ) => new FinishSignIn(signIns, presentations, clients, settings),
    },
    {
        provide: RedeemAuthorizationCode,
        inject: [
            OIDC_SIGN_IN_REPOSITORY,
            SIGN_IN_PRESENTATION,
            ID_TOKEN_SIGNER,
            OIDC_PROVIDER_SETTINGS,
        ],
        useFactory: (
            signIns: OidcSignInRepository,
            presentations: SignInPresentation,
            signer: IdTokenSigner,
            settings: OidcProviderSettings,
        ) =>
            new RedeemAuthorizationCode(
                signIns,
                presentations,
                signer,
                settings.publicUrl,
            ),
    },
];

/**
 * OpenID Provider: relying parties sign users in with a presentation from
 * their wallet, verified by the tenant's presentation configs.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([OidcClientEntity, OidcSignInEntity]),
        AuditLogModule,
        SessionModule,
        PresentationsModule,
        Oid4vpModule,
    ],
    controllers: [OidcClientController, OidcProviderController],
    providers: [
        {
            provide: OIDC_PROVIDER_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService): OidcProviderSettings => {
                const masterSecret = config.get<string>("MASTER_SECRET");
                return {
                    publicUrl: config
                        .getOrThrow<string>("PUBLIC_URL")
                        .replace(/\/+$/, ""),
                    // Changing MASTER_SECRET changes every pairwise subject.
                    subjectKey: masterSecret
                        ? new Uint8Array(
                              hkdfSync(
                                  "sha256",
                                  masterSecret,
                                  "",
                                  "eudiplo-oidc-pairwise-subject",
                                  32,
                              ),
                          )
                        : undefined,
                };
            },
        },
        {
            provide: OIDC_CLIENT_REPOSITORY,
            inject: [getRepositoryToken(OidcClientEntity)],
            useFactory: (repository: Repository<OidcClientEntity>) =>
                new TypeOrmOidcClientRepository(repository),
        },
        {
            provide: OIDC_SIGN_IN_REPOSITORY,
            inject: [getRepositoryToken(OidcSignInEntity)],
            useFactory: (repository: Repository<OidcSignInEntity>) =>
                new TypeOrmOidcSignInRepository(repository),
        },
        {
            provide: SIGN_IN_PRESENTATION,
            inject: [
                Oid4vpService,
                PresentationConfigService,
                SessionStore,
                OIDC_PROVIDER_SETTINGS,
            ],
            useFactory: (
                oid4vp: Oid4vpService,
                configs: PresentationConfigService,
                sessions: SessionStore,
                settings: OidcProviderSettings,
            ) =>
                new Oid4vpSignInPresentation(
                    oid4vp,
                    configs,
                    sessions,
                    settings.publicUrl,
                ),
        },
        {
            provide: ID_TOKEN_SIGNER,
            inject: [KeyChainService],
            useFactory: (keyChains: KeyChainService) =>
                new KeyChainIdTokenSigner(keyChains),
        },
        ...useCaseProviders,
        OidcClientService,
        OidcSignInCleanupJob,
    ],
})
export class OidcProviderModule {}
