import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "../auth/auth.module.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { StatusListModule } from "../issuer/status-list/status-list.module.js";
import { NestSessionEventPublisher } from "./adapters/nest-session-event-publisher.js";
import { OtelSessionMetrics } from "./adapters/otel-session-metrics.js";
import {
    SESSION_MAINTENANCE_SETTINGS,
    SessionMaintenanceJob,
} from "./adapters/session-maintenance.job.js";
import { TypeOrmSessionRepository } from "./adapters/typeorm-session.repository.js";
import { TypeOrmSessionRetentionPolicies } from "./adapters/typeorm-session-retention-policies.js";
import { ChangeSessionState } from "./application/change-session-state.js";
import { CleanupSessions } from "./application/cleanup-sessions.js";
import { CreateSession } from "./application/create-session.js";
import { DeleteSession } from "./application/delete-session.js";
import { GetIso18013Session } from "./application/get-iso18013-session.js";
import { GetSessionByAuthorizationCode } from "./application/get-session-by-authorization-code.js";
import { GetSessionByRefreshToken } from "./application/get-session-by-refresh-token.js";
import { GetSessionByRequestUri } from "./application/get-session-by-request-uri.js";
import { GetSessionForInternalFlow } from "./application/get-session-for-internal-flow.js";
import { GetSessionForTenant } from "./application/get-session-for-tenant.js";
import { GetSessionForWalletRequest } from "./application/get-session-for-wallet-request.js";
import { InitializeSessionMetrics } from "./application/initialize-session-metrics.js";
import { ListSessions } from "./application/list-sessions.js";
import { RecordFailedTxCodeAttempt } from "./application/record-failed-tx-code-attempt.js";
import { ResolveExternalAuthorizationSession } from "./application/resolve-external-authorization-session.js";
import { UpdateSessionForTenant } from "./application/update-session-for-tenant.js";
import { SessionCleanupMode } from "./domain/session-retention.js";
import { Session } from "./entities/session.entity.js";
import { SessionLogEntry } from "./entities/session-log-entry.entity.js";
import { SessionLoggingModule } from "./logging/session-logging.module.js";
import {
    SESSION_REPOSITORY,
    type SessionRepository,
} from "./ports/session.repository.js";
import {
    SESSION_EVENT_PUBLISHER,
    type SessionEventPublisher,
} from "./ports/session-event-publisher.js";
import {
    SESSION_METRICS,
    type SessionMetrics,
} from "./ports/session-metrics.js";
import {
    SESSION_RETENTION_POLICIES,
    type SessionRetentionPolicies,
} from "./ports/session-retention-policies.js";
import { SessionController } from "./session.controller.js";
import { SessionConfigController } from "./session-config.controller.js";
import { SessionConfigService } from "./session-config.service.js";
import { SessionEventsController } from "./session-events.controller.js";
import { SessionEventsService } from "./session-events.service.js";
import { SESSION_SETTINGS } from "./session-settings.js";

/**
 * SessionModule is responsible for managing user sessions.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Session, TenantEntity, SessionLogEntry]),
        StatusListModule,
        SessionLoggingModule,
        AuthModule,
    ],
    providers: [
        {
            provide: CreateSession,
            inject: [SESSION_REPOSITORY, SESSION_METRICS],
            useFactory: (
                sessions: SessionRepository,
                metrics: SessionMetrics,
            ) => new CreateSession(sessions, metrics),
        },
        {
            provide: UpdateSessionForTenant,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new UpdateSessionForTenant(sessions),
        },
        {
            provide: GetSessionForWalletRequest,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new GetSessionForWalletRequest(sessions),
        },
        {
            provide: GetSessionForInternalFlow,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new GetSessionForInternalFlow(sessions),
        },
        {
            provide: GetIso18013Session,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new GetIso18013Session(sessions),
        },
        {
            provide: GetSessionByAuthorizationCode,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new GetSessionByAuthorizationCode(sessions),
        },
        {
            provide: GetSessionByRefreshToken,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new GetSessionByRefreshToken(sessions),
        },
        {
            provide: GetSessionByRequestUri,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new GetSessionByRequestUri(sessions),
        },
        {
            provide: GetSessionForTenant,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new GetSessionForTenant(sessions),
        },
        {
            provide: ResolveExternalAuthorizationSession,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new ResolveExternalAuthorizationSession(sessions),
        },
        {
            provide: RecordFailedTxCodeAttempt,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new RecordFailedTxCodeAttempt(sessions),
        },
        {
            provide: ListSessions,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new ListSessions(sessions),
        },
        {
            provide: DeleteSession,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new DeleteSession(sessions),
        },
        {
            provide: SESSION_RETENTION_POLICIES,
            useClass: TypeOrmSessionRetentionPolicies,
        },
        {
            provide: CleanupSessions,
            inject: [
                SESSION_REPOSITORY,
                SESSION_RETENTION_POLICIES,
                ChangeSessionState,
                ConfigService,
            ],
            useFactory: (
                sessions: SessionRepository,
                policies: SessionRetentionPolicies,
                changeState: ChangeSessionState,
                config: ConfigService,
            ) =>
                new CleanupSessions(sessions, policies, changeState, {
                    ttlSeconds: config.getOrThrow<number>("SESSION_TTL"),
                    cleanupMode: config.getOrThrow<SessionCleanupMode>(
                        "SESSION_CLEANUP_MODE",
                    ),
                }),
        },
        {
            provide: InitializeSessionMetrics,
            inject: [
                SESSION_REPOSITORY,
                SESSION_RETENTION_POLICIES,
                SESSION_METRICS,
            ],
            useFactory: (
                sessions: SessionRepository,
                policies: SessionRetentionPolicies,
                metrics: SessionMetrics,
            ) => new InitializeSessionMetrics(sessions, policies, metrics),
        },
        SessionMaintenanceJob,
        {
            provide: SESSION_MAINTENANCE_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                cleanupIntervalMs:
                    config.getOrThrow<number>("SESSION_TIDY_UP_INTERVAL") *
                    1000,
            }),
        },
        {
            provide: SESSION_EVENT_PUBLISHER,
            useClass: NestSessionEventPublisher,
        },
        { provide: SESSION_METRICS, useClass: OtelSessionMetrics },
        {
            provide: ChangeSessionState,
            inject: [
                SESSION_REPOSITORY,
                SESSION_EVENT_PUBLISHER,
                SESSION_METRICS,
            ],
            useFactory: (
                repository: SessionRepository,
                events: SessionEventPublisher,
                metrics: SessionMetrics,
            ) => new ChangeSessionState(repository, events, metrics),
        },
        SessionConfigService,
        {
            provide: SESSION_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                defaultTtlSeconds: config.getOrThrow<number>("SESSION_TTL"),
                defaultCleanupMode:
                    config.get<string>("SESSION_CLEANUP_MODE") === "anonymize"
                        ? SessionCleanupMode.Anonymize
                        : SessionCleanupMode.Full,
            }),
        },
        SessionEventsService,
        { provide: SESSION_REPOSITORY, useClass: TypeOrmSessionRepository },
    ],
    exports: [
        ResolveExternalAuthorizationSession,
        RecordFailedTxCodeAttempt,
        CleanupSessions,
        ChangeSessionState,
        GetSessionForTenant,
        GetSessionByAuthorizationCode,
        GetSessionByRefreshToken,
        GetSessionByRequestUri,
        GetSessionForWalletRequest,
        GetSessionForInternalFlow,
        GetIso18013Session,
        CreateSession,
        UpdateSessionForTenant,
        SESSION_REPOSITORY,
        SessionConfigService,
        SessionEventsService,
        SessionLoggingModule,
    ],
    controllers: [
        SessionController,
        SessionConfigController,
        SessionEventsController,
    ],
})
export class SessionModule {}
