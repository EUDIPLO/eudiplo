import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const CancelSessionSchema = z
    .object({
        reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict();

/**
 * DTO for cancelling a pending session.
 */
export class CancelSessionDto extends createZodDto(CancelSessionSchema) {
    /**
     * Why the offer was cancelled, stored in the session log.
     */
    @ApiPropertyOptional({
        description:
            "Why the offer was cancelled. Stored in the session log and sent to the session webhook.",
        example: "sent to wrong recipient",
        maxLength: 500,
    })
    reason?: string;
}
