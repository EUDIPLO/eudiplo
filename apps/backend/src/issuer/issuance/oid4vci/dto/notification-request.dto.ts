import { NotificationEvent } from "@openid4vc/openid4vci";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** OID4VCI 1.0 section 11.1: `%x20-21 / %x23-5B / %x5D-7E`. */
const EVENT_DESCRIPTION_PATTERN = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/;

// Not strict: OID4VCI 1.0 section 11.1 requires the issuer to ignore
// unrecognized parameters, so they are stripped instead of rejected.
const NotificationRequestSchema = z.object({
    notification_id: z.string(),
    event: z.enum([
        "credential_accepted",
        "credential_failure",
        "credential_deleted",
    ]),
    event_description: z
        .string()
        .regex(
            EVENT_DESCRIPTION_PATTERN,
            "event_description may only contain the ASCII characters %x20-21 / %x23-5B / %x5D-7E",
        )
        .optional(),
});

export class NotificationRequestDto extends createZodDto(
    NotificationRequestSchema,
) {
    notification_id!: string;

    event!: NotificationEvent;

    event_description?: string;
}
