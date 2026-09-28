import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SessionLogEntry } from "../entities/session-log-entry.entity.js";
import { SessionAuditService } from "./session-audit.service.js";
import { SessionLogStoreService } from "./session-log-store.service.js";
import { SessionLoggerService } from "./session-logger.service.js";
import { SESSION_LOGGING_SETTINGS } from "./session-logging-settings.js";

/**
 * Owns session-scoped protocol logging.
 *
 * Provides two services:
 * - `SessionAuditService`: persists audit events to the database only.
 * - `SessionLoggerService`: persists to the database AND logs via PinoLogger
 *   (exported to Loki via OpenTelemetry) for full observability.
 */
@Module({
    imports: [TypeOrmModule.forFeature([SessionLogEntry])],
    providers: [
        SessionLogStoreService,
        {
            provide: SESSION_LOGGING_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                enabled: config.getOrThrow<boolean>(
                    "LOG_ENABLE_SESSION_LOGGER",
                ),
                storeMode: config.getOrThrow("LOG_SESSION_STORE"),
            }),
        },
        SessionAuditService,
        SessionLoggerService,
    ],
    exports: [
        SessionAuditService,
        SessionLoggerService,
        SessionLogStoreService,
    ],
})
export class SessionLoggingModule {}
