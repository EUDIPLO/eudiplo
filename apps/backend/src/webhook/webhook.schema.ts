import { z } from "zod";
import { WebhookAuthType } from "./domain/webhook-configuration.js";

export const ApiKeyConfigSchema = z
    .object({
        headerName: z
            .string()
            .min(1)
            .describe("The header name used to send the API key."),
        value: z.string().min(1).describe("The API key value."),
    })
    .describe("Configuration for API key authentication.")
    .strict();

export const WebHookAuthConfigHeaderSchema = z
    .object({
        type: z
            .literal(WebhookAuthType.API_KEY)
            .describe("Use API key authentication."),
        config: ApiKeyConfigSchema.describe("API key authentication settings."),
    })
    .describe("Webhook API key authentication variant.")
    .strict();

export const WebHookAuthConfigNoneSchema = z
    .object({
        type: z
            .literal(WebhookAuthType.NONE)
            .describe("Disable authentication."),
    })
    .describe("Webhook no-authentication variant.")
    .strict();

export const WebHookAuthConfigSchema = z
    .discriminatedUnion("type", [
        WebHookAuthConfigNoneSchema,
        WebHookAuthConfigHeaderSchema,
    ])
    .describe("Webhook authentication configuration.");

export const WebhookConfigSchema = z
    .object({
        url: z
            .string()
            .min(1)
            .describe("The URL to which the webhook will send notifications."),
        auth: WebHookAuthConfigSchema.describe(
            "Webhook authentication strategy.",
        ),
        includeRawTokensFor: z
            .array(z.string())
            .optional()
            .describe(
                "List of credential IDs to include raw tokens for (for example ['sca_credential']).",
            ),
    })
    .describe("Webhook configuration used in issuance and presentation flows.")
    .strict();
