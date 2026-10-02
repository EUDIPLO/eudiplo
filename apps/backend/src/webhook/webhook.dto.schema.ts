import { z } from "zod";
import { WebhookAuthType as AuthConfig } from "./domain/webhook-configuration.js";

export const ApiKeyConfigSchema = z
    .object({
        headerName: z.string(),
        value: z.string(),
    })
    .strict();

export const WebHookAuthConfigHeaderSchema = z
    .object({
        type: z.literal(AuthConfig.API_KEY),
        config: ApiKeyConfigSchema,
    })
    .strict();

export const WebHookAuthConfigNoneSchema = z
    .object({
        type: z.literal(AuthConfig.NONE),
    })
    .strict();

export const WebHookAuthConfigSchema = z.discriminatedUnion("type", [
    WebHookAuthConfigNoneSchema,
    WebHookAuthConfigHeaderSchema,
]);

export const WebhookConfigSchema = z
    .object({
        url: z.string(),
        auth: WebHookAuthConfigSchema,
        includeRawTokensFor: z.array(z.string()).optional(),
    })
    .strict();
