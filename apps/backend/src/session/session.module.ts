import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "../auth/auth.module.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { StatusListModule } from "../issuer/status-list/status-list.module.js";
import { NestSessionEventPublisher } from "./adapters/nest-session-event-publisher.js";
import { OtelSessionMetrics } from "./adapters/otel-session-metrics.js";
import { RequestSessionContext } from "./adapters/request-session-context.js";
import {
    SESSION_MAINTENANCE_SETTINGS,
    SessionMaintenanceJob,
} from "./adapters/session-maintenance.job.js";
import { TypeOrmSessionRepository } from "./adapters/typeorm-session.repository.js";
import { TypeOrmSessionRetentionPolicies } from "./adapters/typeorm-session-retention-policies.js";
import { ChangeSessionState } from "./application/change-session-state.js";
import { CleanupSessions } from "./application/cleanup-sessions.js";
import { CreateSession } from "./application/create-session.js";
import { RecordFailedTxCodeAttempt } from "./application/record-failed-tx-code-attempt.js";
import { ResolveExternalAuthorizationSession } from "./application/resolve-external-authorization-session.js";
import { SessionStore } from "./application/session-store.js";
import { SessionCleanupMode } from "./domain/session-retention.js";
import { Session } from "./entities/session.entity.js";
import { SessionLogEntry } from "./entities/session-log-entry.entity.js";
import { SessionLoggingModule } from "./logging/session-logging.module.js";
import {
    SESSION_REPOSITORY,
    type SessionRepository,
} from "./ports/session.repository.js";
import {
    SESSION_CONTEXT,
    type SessionContext,
} from "./ports/session-context.js";
import {
    SESSION_EVENT_PUBLISHER,
    type SessionEventPublisher,
} from "./ports/session-event-publisher.js";
import {
    SESSION_RETENTION_POLICIES,
    type SessionRetentionPolicies,
} from "./ports/session-retention-policies.js";
import { SessionController } from "./session.controller.js";
import { SessionConfigController } from "./session-config.controller.js";
import { SessionConfigService } from "./session-config.service.js";
import { SessionEventsController } from "./session-events.controller.js";
import { SessionEventsService } from "./session-events.service.js";
import { SESSION_SETTINGS, type SessionSettings } from "./session-settings.js";

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
        { provide: SESSION_CONTEXT, useClass: RequestSessionContext },
        {
            provide: CreateSession,
            inject: [SESSION_REPOSITORY, SESSION_CONTEXT],
            useFactory: (
                sessions: SessionRepository,
                context: SessionContext,
            ) => new CreateSession(sessions, context),
        },
        {
            provide: SessionStore,
            inject: [SESSION_REPOSITORY, SESSION_CONTEXT],
            useFactory: (
                sessions: SessionRepository,
                context: SessionContext,
            ) => new SessionStore(sessions, context),
        },
        {
            provide: ResolveExternalAuthorizationSession,
            inject: [SESSION_REPOSITORY, SESSION_CONTEXT],
            useFactory: (
                sessions: SessionRepository,
                context: SessionContext,
            ) => new ResolveExternalAuthorizationSession(sessions, context),
        },
        {
            provide: RecordFailedTxCodeAttempt,
            inject: [SESSION_REPOSITORY],
            useFactory: (sessions: SessionRepository) =>
                new RecordFailedTxCodeAttempt(sessions),
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
                SESSION_SETTINGS,
            ],
            useFactory: (
                sessions: SessionRepository,
                policies: SessionRetentionPolicies,
                changeState: ChangeSessionState,
                settings: SessionSettings,
            ) =>
                new CleanupSessions(sessions, policies, changeState, {
                    ttlSeconds: settings.defaultTtlSeconds,
                    cleanupMode: settings.defaultCleanupMode,
                }),
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
        OtelSessionMetrics,
        {
            provide: ChangeSessionState,
            inject: [SESSION_REPOSITORY, SESSION_EVENT_PUBLISHER],
            useFactory: (
                repository: SessionRepository,
                events: SessionEventPublisher,
            ) => new ChangeSessionState(repository, events),
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
        SessionStore,
        CreateSession,
        ChangeSessionState,
        ResolveExternalAuthorizationSession,
        RecordFailedTxCodeAttempt,
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
