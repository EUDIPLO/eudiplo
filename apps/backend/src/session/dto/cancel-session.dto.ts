import { ApiPropertyOptional } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

// Without a body Express 5 leaves `req.body` undefined; the default lets a
// plain `POST /session/{id}/cancel` through like `{}`.
const CancelSessionSchema = z
    .object({
        reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict()
    .default({});

/**
 * DTO for cancelling a pending session.
 */
export class CancelSessionDto extends createZodDto(CancelSessionSchema) {
    /**
     * Why the offer was cancelled, stored in the audit logs.
     */
    @ApiPropertyOptional({
        description:
            "Why the offer was cancelled. Stored in the audit logs and sent to the session webhook.",
        example: "sent to wrong recipient",
        maxLength: 500,
    })
    reason?: string;
}
