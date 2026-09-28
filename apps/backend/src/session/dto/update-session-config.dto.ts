import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { SessionCleanupMode } from "../domain/session-retention.js";

const UpdateSessionConfigSchema = z
    .object({
        ttlSeconds: z.coerce.number().int().min(60).nullable().optional(),
        cleanupMode: z.enum(SessionCleanupMode).optional(),
    })
    .strict();

/**
 * DTO for updating session storage configuration.
 */
export class UpdateSessionConfigDto extends createZodDto(
    UpdateSessionConfigSchema,
) {
    /**
     * Time-to-live for sessions in seconds.
     * After this period, sessions are eligible for cleanup.
     * If not set or null, uses the global SESSION_TTL environment variable.
     */
    @ApiPropertyOptional({
        description:
            "Time-to-live for sessions in seconds. Set to null to use global default.",
        example: 86400,
        minimum: 60,
    })
    ttlSeconds?: number | null;

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
