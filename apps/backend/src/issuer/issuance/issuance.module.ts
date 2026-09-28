import { HttpModule, HttpService } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MetricService, TraceService } from "nestjs-otel";
import { v4 } from "uuid";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { EncryptionService } from "../../crypto/encryption/encryption.service.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { RegistrarService } from "../../registrar/registrar.service.js";
import { ChangeSessionState } from "../../session/application/change-session-state.js";
import { CreateSession } from "../../session/application/create-session.js";
import { ResolveExternalAuthorizationSession } from "../../session/application/resolve-external-authorization-session.js";
import { SessionStore } from "../../session/application/session-store.js";
import { SessionModule } from "../../session/session.module.js";
import { FederationTrustService } from "../../trust/federation-trust.service.js";
import { TrustModule } from "../../trust/trust.module.js";
import { TrustStoreService } from "../../trust/trust-store.service.js";
import { X509ValidationService } from "../../trust/x509-validation.service.js";
import { Oid4vpModule } from "../../verifier/oid4vp/oid4vp.module.js";
import { PresentationsModule } from "../../verifier/presentations/presentations.module.js";
import { WebhookModule } from "../../webhook/webhook.module.js";
import { ConfigurationModule } from "../configuration/configuration.module.js";
import { CredentialsService } from "../configuration/credentials/credentials.service.js";
import {
    CREDENTIAL_CLAIMS_PROVIDER,
    type CredentialClaimsProvider,
} from "../configuration/credentials/domain/credential-claims.js";
import { IssuanceService } from "../configuration/issuance/issuance.service.js";
import {
    WEBHOOK_ENDPOINT_REPOSITORY,
    type WebhookEndpointRepository,
} from "../configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import { StatusListModule } from "../status-list/status-list.module.js";
import { CredentialOfferController } from "./offer/credential-offer.controller.js";
import { ConfiguredCredentialAuthorizationSources } from "./oid4vci/adapters/configured-credential-authorization-sources.js";
import { ConfiguredIssuerMetadataSources } from "./oid4vci/adapters/configured-issuer-metadata-sources.js";
import { OpenIdCredentialOfferProtocol } from "./oid4vci/adapters/credential-offer-protocol.js";
import { CredentialsServiceBatchIssuer } from "./oid4vci/adapters/credentials-service-batch-issuer.js";
import { CredentialsServiceDeferredCredentialIssuer } from "./oid4vci/adapters/credentials-service-deferred-credential-issuer.js";
import { DeferredTransactionCleanupJob } from "./oid4vci/adapters/deferred-transaction-cleanup.job.js";
import { HostedAuthorizationServerMetadataAdapter } from "./oid4vci/adapters/hosted-authorization-server-metadata.adapter.js";
import { HttpExternalAuthorizationServerMetadataResolver } from "./oid4vci/adapters/http-external-authorization-server-metadata-resolver.js";
import { OpenIdCredentialProofVerifier } from "./oid4vci/adapters/openid-credential-proof-verifier.js";
import { RegistrarIssuerRegistrationCertificateProvider } from "./oid4vci/adapters/registrar-issuer-registration-certificate-provider.js";
import { TypeOrmDeferredTransactionRepository } from "./oid4vci/adapters/typeorm-deferred-transaction.repository.js";
import { WebhookCredentialNotificationPublisher } from "./oid4vci/adapters/webhook-credential-notification-publisher.js";
import { BuildIssuerMetadata } from "./oid4vci/application/build-issuer-metadata.js";
import { CompleteDeferredCredential } from "./oid4vci/application/complete-deferred-credential.js";
import { CreateCredentialOffer } from "./oid4vci/application/create-credential-offer.js";
import { FailDeferredCredential } from "./oid4vci/application/fail-deferred-credential.js";
import { HandleCredentialNotification } from "./oid4vci/application/handle-credential-notification.js";
import { IssueCredentialsForKeys } from "./oid4vci/application/issue-credentials-for-keys.js";
import { IssueCredentialsFromProofs } from "./oid4vci/application/issue-credentials-from-proofs.js";
import { RecordCredentialNotification } from "./oid4vci/application/record-credential-notification.js";
import { ResolveAuthorizedCredentialConfiguration } from "./oid4vci/application/resolve-authorized-credential-configuration.js";
import { ResolveCredentialProofs } from "./oid4vci/application/resolve-credential-proofs.js";
import { ResolveCredentialSession } from "./oid4vci/application/resolve-credential-session.js";
import { ResolveDeferredCredentialRetrieval } from "./oid4vci/application/resolve-deferred-credential-retrieval.js";
import { RetrieveCredentialOffer } from "./oid4vci/application/retrieve-credential-offer.js";
import { SelectAuthorizationServer } from "./oid4vci/application/select-authorization-server.js";
import { AuthorizationModule } from "./oid4vci/authorization/authorization.module.js";
import { AuthorizationServersService } from "./oid4vci/authorization/authorization-servers/authorization-servers.service.js";
import { AuthorizeService } from "./oid4vci/authorization/authorize/authorize.service.js";
import { ChainedAsService } from "./oid4vci/authorization/chained-as/chained-as.service.js";
import { ChainedAsVpService } from "./oid4vci/authorization/chained-as-vp/chained-as-vp.service.js";
import { CredentialAccessTokenVerifier } from "./oid4vci/credential-access-token.verifier.js";
import { CredentialNonceModule } from "./oid4vci/credential-nonce.module.js";
import { CredentialOfferReferenceController } from "./oid4vci/credential-offer-reference.controller.js";
import { DeferredController } from "./oid4vci/deferred.controller.js";
import { DeferredCredentialService } from "./oid4vci/deferred-credential.service.js";
import { DeferredTransactionEntity } from "./oid4vci/entities/deferred-transaction.entity.js";
import { Oid4vciMetadataController } from "./oid4vci/metadata/oid4vci-metadata.controller.js";
import { NonceService } from "./oid4vci/nonce.service.js";
import { Oid4vciController } from "./oid4vci/oid4vci.controller.js";
import { Oid4vciService } from "./oid4vci/oid4vci.service.js";
import { Oid4vciSdkFactory } from "./oid4vci/oid4vci-sdk.factory.js";
import {
    OID4VCI_SETTINGS,
    type Oid4vciSettings,
} from "./oid4vci/oid4vci-settings.js";
import {
    EXTERNAL_AUTHORIZATION_SERVER_METADATA_RESOLVER,
    type ExternalAuthorizationServerMetadataResolver,
    HOSTED_AUTHORIZATION_SERVER_METADATA,
    type HostedAuthorizationServerMetadata,
} from "./oid4vci/ports/authorization-server-metadata.js";
import {
    CREDENTIAL_AUTHORIZATION_SOURCES,
    type CredentialAuthorizationSources,
} from "./oid4vci/ports/credential-authorization-sources.js";
import { CREDENTIAL_BATCH_ISSUER } from "./oid4vci/ports/credential-batch-issuer.js";
import type { CredentialNotificationPublisher } from "./oid4vci/ports/credential-notification-publisher.js";
import { CREDENTIAL_NOTIFICATION_PUBLISHER } from "./oid4vci/ports/credential-notification-publisher.js";
import {
    CREDENTIAL_OFFER_PROTOCOL,
    type CredentialOfferProtocol,
} from "./oid4vci/ports/credential-offer-protocol.js";
import {
    CREDENTIAL_PROOF_VERIFIER,
    type CredentialProofVerifier,
} from "./oid4vci/ports/credential-proof-verifier.js";
import {
    DEFERRED_TRANSACTION_REPOSITORY,
    type DeferredTransactionRepository,
} from "./oid4vci/ports/deferred-transaction.repository.js";
import {
    ISSUER_METADATA_SOURCES,
    type IssuerMetadataSources,
} from "./oid4vci/ports/issuer-metadata-sources.js";
import {
    ISSUER_REGISTRATION_CERTIFICATE_PROVIDER,
    type IssuerRegistrationCertificateProvider,
} from "./oid4vci/ports/issuer-registration-certificate-provider.js";
import { WellKnownController } from "./oid4vci/well-known/well-known.controller.js";
import { WellKnownService } from "./oid4vci/well-known/well-known.service.js";

/**
 * Issuance Module - Handles credential issuance operations
 *
 * Responsibilities:
 * - Creating credential offers
 * - OID4VCI protocol implementation
 * - Authorization and token management
 * - Credential issuance workflows
 */
@Module({
    imports: [
        CryptoModule,
        ConfigurationModule,
        Oid4vpModule,
        PresentationsModule,
        SessionModule,
        HttpModule,
        TrustModule,
        WebhookModule,
        StatusListModule,
        AuthorizationModule,
        CredentialNonceModule,
        RegistrarModule,
        TypeOrmModule.forFeature([DeferredTransactionEntity]),
    ],
    controllers: [
        CredentialOfferReferenceController,
        Oid4vciController,
        CredentialOfferController,
        DeferredController,
        Oid4vciMetadataController,
        WellKnownController,
    ],
    providers: [
        {
            provide: RetrieveCredentialOffer,
            inject: [SessionStore, ConfigService],
            useFactory: (sessions: SessionStore, config: ConfigService) =>
                new RetrieveCredentialOffer(sessions, {
                    allowMultipleConsumption: config.getOrThrow<boolean>(
                        "ISSUER_MULTI_CONSUMPTION",
                    ),
                }),
        },
        {
            provide: RecordCredentialNotification,
            inject: [SessionStore],
            useFactory: (sessions: SessionStore) =>
                new RecordCredentialNotification(sessions),
        },
        Oid4vciSdkFactory,
        CredentialAccessTokenVerifier,
        {
            provide: EXTERNAL_AUTHORIZATION_SERVER_METADATA_RESOLVER,
            inject: [
                HttpService,
                FederationTrustService,
                { token: MetricService, optional: true },
            ],
            useFactory: (
                http: HttpService,
                federation: FederationTrustService,
                metrics?: MetricService,
            ) =>
                new HttpExternalAuthorizationServerMetadataResolver(
                    http,
                    federation,
                    metrics,
                ),
        },
        {
            provide: HOSTED_AUTHORIZATION_SERVER_METADATA,
            inject: [
                AuthorizeService,
                AuthorizationServersService,
                ChainedAsService,
                ChainedAsVpService,
            ],
            useFactory: (
                builtIn: AuthorizeService,
                oid4vp: AuthorizationServersService,
                chainedAs: ChainedAsService,
                chainedAsVp: ChainedAsVpService,
            ) =>
                new HostedAuthorizationServerMetadataAdapter(
                    builtIn,
                    oid4vp,
                    chainedAs,
                    chainedAsVp,
                ),
        },
        {
            provide: ISSUER_METADATA_SOURCES,
            inject: [CredentialsService, EncryptionService],
            useFactory: (
                credentials: CredentialsService,
                encryption: EncryptionService,
            ) => new ConfiguredIssuerMetadataSources(credentials, encryption),
        },
        {
            provide: ISSUER_REGISTRATION_CERTIFICATE_PROVIDER,
            inject: [RegistrarService, CredentialsService, IssuanceService],
            useFactory: (
                registrar: RegistrarService,
                credentials: CredentialsService,
                issuance: IssuanceService,
            ) =>
                new RegistrarIssuerRegistrationCertificateProvider(
                    registrar,
                    credentials,
                    issuance,
                ),
        },
        {
            provide: BuildIssuerMetadata,
            inject: [
                IssuanceService,
                HOSTED_AUTHORIZATION_SERVER_METADATA,
                EXTERNAL_AUTHORIZATION_SERVER_METADATA_RESOLVER,
                ISSUER_METADATA_SOURCES,
                ISSUER_REGISTRATION_CERTIFICATE_PROVIDER,
                OID4VCI_SETTINGS,
            ],
            useFactory: (
                issuance: IssuanceService,
                hosted: HostedAuthorizationServerMetadata,
                external: ExternalAuthorizationServerMetadataResolver,
                sources: IssuerMetadataSources,
                certificates: IssuerRegistrationCertificateProvider,
                settings: Oid4vciSettings,
            ) =>
                new BuildIssuerMetadata(
                    {
                        getForTenant: (tenantId) =>
                            issuance.getIssuanceConfiguration(tenantId),
                    },
                    hosted,
                    external,
                    sources,
                    certificates,
                    settings.publicUrl,
                ),
        },
        {
            provide: SelectAuthorizationServer,
            inject: [IssuanceService, OID4VCI_SETTINGS],
            useFactory: (
                issuance: IssuanceService,
                settings: Oid4vciSettings,
            ) =>
                new SelectAuthorizationServer(
                    {
                        getForTenant: (tenantId) =>
                            issuance.getIssuanceConfiguration(tenantId),
                    },
                    settings.publicUrl,
                ),
        },
        {
            provide: CREDENTIAL_OFFER_PROTOCOL,
            inject: [
                Oid4vciSdkFactory,
                BuildIssuerMetadata,
                CredentialsService,
                TraceService,
                OID4VCI_SETTINGS,
            ],
            useFactory: (
                sdk: Oid4vciSdkFactory,
                metadata: BuildIssuerMetadata,
                credentials: CredentialsService,
                trace: TraceService,
                settings: Oid4vciSettings,
            ) =>
                new OpenIdCredentialOfferProtocol(
                    sdk,
                    metadata,
                    credentials,
                    trace,
                    settings,
                ),
        },
        {
            provide: CreateCredentialOffer,
            inject: [
                CreateSession,
                SessionStore,
                SelectAuthorizationServer,
                CREDENTIAL_OFFER_PROTOCOL,
            ],
            useFactory: (
                sessions: CreateSession,
                update: SessionStore,
                authorizationServers: SelectAuthorizationServer,
                protocol: CredentialOfferProtocol,
            ) =>
                new CreateCredentialOffer(
                    sessions,
                    update,
                    authorizationServers,
                    protocol,
                    v4,
                ),
        },
        {
            provide: CREDENTIAL_BATCH_ISSUER,
            inject: [CredentialsService],
            useFactory: (credentials: CredentialsService) =>
                new CredentialsServiceBatchIssuer(credentials),
        },
        {
            provide: IssueCredentialsForKeys,
            inject: [CREDENTIAL_BATCH_ISSUER],
            useFactory: (issuer: CredentialsServiceBatchIssuer) =>
                new IssueCredentialsForKeys(issuer),
        },
        {
            provide: DEFERRED_TRANSACTION_REPOSITORY,
            useClass: TypeOrmDeferredTransactionRepository,
        },
        DeferredTransactionCleanupJob,
        {
            provide: CredentialsServiceDeferredCredentialIssuer,
            inject: [CredentialsService],
            useFactory: (credentials: CredentialsService) =>
                new CredentialsServiceDeferredCredentialIssuer(credentials),
        },
        {
            provide: CompleteDeferredCredential,
            inject: [
                DEFERRED_TRANSACTION_REPOSITORY,
                SessionStore,
                CredentialsServiceDeferredCredentialIssuer,
            ],
            useFactory: (
                transactions: DeferredTransactionRepository,
                sessions: SessionStore,
                issuer: CredentialsServiceDeferredCredentialIssuer,
            ) => new CompleteDeferredCredential(transactions, sessions, issuer),
        },
        {
            provide: FailDeferredCredential,
            inject: [DEFERRED_TRANSACTION_REPOSITORY],
            useFactory: (transactions: DeferredTransactionRepository) =>
                new FailDeferredCredential(transactions),
        },
        ResolveDeferredCredentialRetrieval,
        ResolveAuthorizedCredentialConfiguration,
        ResolveCredentialProofs,
        {
            provide: CREDENTIAL_NOTIFICATION_PUBLISHER,
            useClass: WebhookCredentialNotificationPublisher,
        },
        DeferredCredentialService,
        NonceService,
        Oid4vciService,
        {
            provide: CREDENTIAL_PROOF_VERIFIER,
            inject: [
                Oid4vciSdkFactory,
                BuildIssuerMetadata,
                TrustStoreService,
                X509ValidationService,
            ],
            useFactory: (
                sdk: Oid4vciSdkFactory,
                metadata: BuildIssuerMetadata,
                trust: TrustStoreService,
                x509: X509ValidationService,
            ) => new OpenIdCredentialProofVerifier(sdk, metadata, trust, x509),
        },
        {
            provide: IssueCredentialsFromProofs,
            inject: [CREDENTIAL_PROOF_VERIFIER, IssueCredentialsForKeys],
            useFactory: (
                verifier: CredentialProofVerifier,
                issuer: IssueCredentialsForKeys,
            ) => new IssueCredentialsFromProofs(verifier, issuer),
        },
        {
            provide: HandleCredentialNotification,
            inject: [
                RecordCredentialNotification,
                WEBHOOK_ENDPOINT_REPOSITORY,
                CREDENTIAL_NOTIFICATION_PUBLISHER,
                ChangeSessionState,
            ],
            useFactory: (
                record: RecordCredentialNotification,
                endpoints: WebhookEndpointRepository,
                publisher: CredentialNotificationPublisher,
                state: ChangeSessionState,
            ) =>
                new HandleCredentialNotification(
                    record,
                    endpoints,
                    publisher,
                    state,
                ),
        },
        {
            provide: CREDENTIAL_AUTHORIZATION_SOURCES,
            inject: [
                AuthorizeService,
                AuthorizationServersService,
                ChainedAsService,
                IssuanceService,
                OID4VCI_SETTINGS,
            ],
            useFactory: (
                authorization: AuthorizeService,
                servers: AuthorizationServersService,
                chained: ChainedAsService,
                issuance: IssuanceService,
                settings: Oid4vciSettings,
            ) =>
                new ConfiguredCredentialAuthorizationSources(
                    authorization,
                    servers,
                    chained,
                    issuance,
                    settings,
                ),
        },
        {
            provide: ResolveCredentialSession,
            inject: [
                CREDENTIAL_AUTHORIZATION_SOURCES,
                SessionStore,
                ResolveExternalAuthorizationSession,
                CREDENTIAL_CLAIMS_PROVIDER,
            ],
            useFactory: (
                sources: CredentialAuthorizationSources,
                sessions: SessionStore,
                externalSessions: ResolveExternalAuthorizationSession,
                claims: CredentialClaimsProvider,
            ) =>
                new ResolveCredentialSession(
                    sources,
                    sessions,
                    externalSessions,
                    claims,
                ),
        },
        WellKnownService,
    ],
    exports: [AuthorizationModule],
})
export class IssuanceModule {}
