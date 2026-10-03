import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const StatusUpdateSchema = z
    .object({
        sessionId: z
            .string()
            .min(1)
            .describe(
                "Session identifier used to locate credentials for status updates.",
            ),
        credentialConfigurationId: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Optional credential configuration id. If omitted, all credentials linked to the session are updated.",
            ),
        status: z
            .number()
            .int()
            .min(0)
            .max(2)
            .describe(
                "New credential status: 0 = valid, 1 = revoked, 2 = suspended. The value must fit every status list the credentials use: suspension needs lists with at least 2 bits per entry, otherwise the request is rejected with 400 and no status is changed.",
            ),
    })
    .describe(
        "Request payload for updating credential status entries by session.",
    )
    .strict();

export class StatusUpdateDto extends createZodDto(StatusUpdateSchema) {}
