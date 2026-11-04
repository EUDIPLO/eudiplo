import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { SessionStatsFilter } from "../domain/session-stats.js";
import { orderedRange, timestamp } from "./session-query.dto.js";

export const SessionStatsQuerySchema = z
    .object({
        createdFrom: timestamp.optional(),
        createdTo: timestamp.optional(),
    })
    .strict()
    .refine(...orderedRange("createdFrom", "createdTo"));

/**
 * Limits the counted sessions to a creation time range, like the session list.
 */
export class SessionStatsQueryDto
    extends createZodDto(SessionStatsQuerySchema)
    implements SessionStatsFilter
{
    @ApiPropertyOptional({
        type: String,
        format: "date-time",
        description: "Only sessions created at or after this time (ISO 8601)",
    })
    createdFrom?: Date;

    @ApiPropertyOptional({
        type: String,
        format: "date-time",
        description: "Only sessions created at or before this time (ISO 8601)",
    })
    createdTo?: Date;
}
