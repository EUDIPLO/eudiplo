import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TraceService } from "nestjs-otel";
import { v4 } from "uuid";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { ChangeSessionState } from "../../session/application/change-session-state.js";
import { CreateSession } from "../../session/application/create-session.js";
import { GetSessionForTenant } from "../../session/application/get-session-for-tenant.js";
import { ResolveExternalAuthorizationSession } from "../../session/application/resolve-external-authorization-session.js";
import { UpdateSessionForTenant } from "../../session/application/update-session-for-tenant.js";
import {
    SESSION_REPOSITORY,
    type SessionRepository,
} from "../../session/ports/session.repository.js";
import { SessionModule } from "../../session/session.module.js";
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
import { WebhookEndpointEntity } from "../configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import {
    WEBHOOK_ENDPOINT_REPOSITORY,
    type WebhookEndpointRepository,
} from "../configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import { StatusListModule } from "../status-list/status-list.module.js";
import { CredentialOfferController } from "./offer/credential-offer.controller.js";
import { ConfiguredCredentialAuthorizationSources } from "./oid4vci/adapters/configured-credential-authorization-sources.js";
import { OpenIdCredentialOfferProtocol } from "./oid4vci/adapters/credential-offer-protocol.js";
import { CredentialsServiceBatchIssuer } from "./oid4vci/adapters/credentials-service-batch-issuer.js";
import { CredentialsServiceDeferredCredentialIssuer } from "./oid4vci/adapters/credentials-service-deferred-credential-issuer.js";
import { Oid4vciProtocolMetadata } from "./oid4vci/adapters/oid4vci-protocol-metadata.js";
import { OpenIdCredentialProofVerifier } from "./oid4vci/adapters/openid-credential-proof-verifier.js";
import { TypeOrmDeferredTransactionRepository } from "./oid4vci/adapters/typeorm-deferred-transaction.repository.js";
import { WebhookCredentialNotificationPublisher } from "./oid4vci/adapters/webhook-credential-notification-publisher.js";
import { BuildCredentialOfferGrants } from "./oid4vci/application/build-credential-offer-grants.js";
import { ClassifyAuthorizationServerToken } from "./oid4vci/application/classify-authorization-server-token.js";
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
import { AuthorizationModule } from "./oid4vci/authorization/authorization.module.js";
import { AuthorizationServersService } from "./oid4vci/authorization/authorization-servers/authorization-servers.service.js";
import { AuthorizeService } from "./oid4vci/authorization/authorize/authorize.service.js";
import { ChainedAsService } from "./oid4vci/authorization/chained-as/chained-as.service.js";
import { CredentialNonceModule } from "./oid4vci/credential-nonce.module.js";
import { CredentialOfferReferenceController } from "./oid4vci/credential-offer-reference.controller.js";
import { DeferredController } from "./oid4vci/deferred.controller.js";
import { DeferredCredentialService } from "./oid4vci/deferred-credential.service.js";
import { DeferredTransactionEntity } from "./oid4vci/entities/deferred-transaction.entity.js";
import { Oid4vciMetadataController } from "./oid4vci/metadata/oid4vci-metadata.controller.js";
import { NonceService } from "./oid4vci/nonce.service.js";
import { Oid4vciController } from "./oid4vci/oid4vci.controller.js";
import { Oid4vciService } from "./oid4vci/oid4vci.service.js";
import {
    OID4VCI_SETTINGS,
    type Oid4vciSettings,
} from "./oid4vci/oid4vci-settings.js";
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
        TypeOrmModule.forFeature([
            DeferredTransactionEntity,
            WebhookEndpointEntity,
        ]),
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
            inject: [SESSION_REPOSITORY, ConfigService],
            useFactory: (sessions: SessionRepository, config: ConfigService) =>
                new RetrieveCredentialOffer(sessions, {
                    allowMultipleConsumption: config.getOrThrow<boolean>(
                        "ISSUER_MULTI_CONSUMPTION",
                    ),
                }),
        },
        {
            provide: RecordCredentialNotification,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new RecordCredentialNotification(sessions),
        },
        BuildCredentialOfferGrants,
        {
            provide: CREDENTIAL_OFFER_PROTOCOL,
            inject: [
                Oid4vciProtocolMetadata,
                CredentialsService,
                TraceService,
                OID4VCI_SETTINGS,
            ],
            useFactory: (
                metadata: Oid4vciProtocolMetadata,
                credentials: CredentialsService,
                trace: TraceService,
                settings: Oid4vciSettings,
            ) =>
                new OpenIdCredentialOfferProtocol(
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
                UpdateSessionForTenant,
                CREDENTIAL_OFFER_PROTOCOL,
            ],
            useFactory: (
                sessions: CreateSession,
                update: UpdateSessionForTenant,
                protocol: CredentialOfferProtocol,
            ) => new CreateCredentialOffer(sessions, update, protocol, v4),
        },
        ClassifyAuthorizationServerToken,
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
                GetSessionForTenant,
                CredentialsServiceDeferredCredentialIssuer,
            ],
            useFactory: (
                transactions: DeferredTransactionRepository,
                sessions: GetSessionForTenant,
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
            provide: OID4VCI_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
                internalUrl: config.get<string>("INTERNAL_URL"),
            }),
        },
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
                Oid4vciProtocolMetadata,
                TrustStoreService,
                X509ValidationService,
            ],
            useFactory: (
                metadata: Oid4vciProtocolMetadata,
                trust: TrustStoreService,
                x509: X509ValidationService,
            ) => new OpenIdCredentialProofVerifier(metadata, trust, x509),
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
        Oid4vciProtocolMetadata,
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
                GetSessionForTenant,
                ResolveExternalAuthorizationSession,
                CREDENTIAL_CLAIMS_PROVIDER,
            ],
            useFactory: (
                sources: CredentialAuthorizationSources,
                sessions: GetSessionForTenant,
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
    exports: [AuthorizationModule, Oid4vciService, Oid4vciProtocolMetadata],
})
export class IssuanceModule {}
