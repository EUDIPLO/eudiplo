import { z } from "zod";
import { WebhookConfigSchema } from "../../../webhook/webhook.schema.js";
import { TransactionDataSchema } from "../../presentations/schemas/presentation-config.schema.js";

export const ResponseType = {
    URI: "uri",
    DC_API: "dc-api",
    ISO_18013_7: "iso-18013-7",
} as const;

export const ClientIdScheme = {
    X509_HASH: "x509_hash",
    X509_SAN_DNS: "x509_san_dns",
} as const;

export const PresentationRequestSchema = z
    .object({
        response_type: z
            .union([
                z.literal(ResponseType.URI),
                z.literal(ResponseType.DC_API),
                z.literal(ResponseType.ISO_18013_7),
            ])
            .describe("Response mode for the presentation request."),
        requestId: z
            .string()
            .describe("Identifier of the presentation configuration to use."),
        webhook: WebhookConfigSchema.optional().describe(
            "Inline webhook override; otherwise the configured webhook is used.",
        ),
        redirectUri: z
            .string()
            .optional()
            .describe(
                "Redirect URI after completion; supports the {sessionId} placeholder.",
            ),
        expected_origin: z
            .string()
            .optional()
            .describe("Expected browser origin for DC API key binding."),
        transaction_data: z
            .array(TransactionDataSchema)
            .optional()
            .describe(
                "Transaction data overriding the presentation configuration.",
            ),
        skewSeconds: z
            .number()
            .min(0)
            .optional()
            .describe(
                "Clock skew override in seconds for credential JWT time validation.",
            ),
        clientIdScheme: z
            .enum([ClientIdScheme.X509_HASH, ClientIdScheme.X509_SAN_DNS])
            .optional()
            .describe(
                "OID4VP client identifier scheme; defaults to x509_hash.",
            ),
        reference: z
            .string()
            .trim()
            .min(1)
            .max(255)
            .optional()
            .describe(
                "Your own reference for this request, e.g. an order or case id. Stored in plaintext, searchable in the session list, included in webhooks and kept when the session is anonymized. Must not contain personal data.",
            ),
    })
    .strict();
