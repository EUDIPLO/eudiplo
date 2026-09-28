import { ApiPropertyOptional } from "@nestjs/swagger";

import { SessionCleanupMode } from "../../../session/domain/session-retention.js";

/**
 * Configuration for session storage and cleanup behavior per tenant.
 */
export class SessionStorageConfig {
    /**
     * Time-to-live for sessions in seconds.
     * After this period, sessions are eligible for cleanup.
     * If not set, uses the global SESSION_TTL environment variable (default: 86400 = 24h).
     */
    @ApiPropertyOptional({
        description:
            "Time-to-live for sessions in seconds. If not set, uses global SESSION_TTL.",
        example: 86400,
        minimum: 60,
    })
    ttlSeconds?: number;

    /**
     * Cleanup mode when sessions expire.
     * - 'full': Delete the entire session record (default)
     * - 'anonymize': Keep session metadata but remove personal data
     */
    @ApiPropertyOptional({
        description:
            "Cleanup mode: 'full' deletes everything, 'anonymize' keeps metadata but removes PII.",
        enum: SessionCleanupMode,
        default: SessionCleanupMode.Full,
    })
    cleanupMode?: SessionCleanupMode;
}
