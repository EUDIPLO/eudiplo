import { ApiExtraModels, ApiProperty, getSchemaPath } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { WebhookConfiguration } from "./domain/webhook-configuration.js";
import { WebhookAuthType as AuthConfig } from "./domain/webhook-configuration.js";
import {
    ApiKeyConfigSchema,
    WebHookAuthConfigHeaderSchema,
    WebHookAuthConfigNoneSchema,
    WebHookAuthConfigSchema,
    WebhookConfigSchema,
} from "./webhook.dto.schema.js";

export {
    WebHookAuthConfigSchema,
    WebhookConfigSchema,
} from "./webhook.dto.schema.js";

/**
 * Configuration for API key authentication in webhooks.
 */
export class ApiKeyConfig extends createZodDto(ApiKeyConfigSchema) {
    /**
     * The name of the header where the API key will be sent.
     */
    headerName!: string;
    /**
     * The value of the API key to be sent in the header.
     */
    value!: string;
}

/**
 * Enum for the type of authentication used in webhooks.
 */
export { WebhookAuthType as AuthConfig } from "./domain/webhook-configuration.js";

/**
 * Configuration for webhook authentication.
 */
export class WebHookAuthConfigHeader extends createZodDto(
    WebHookAuthConfigHeaderSchema,
) {
    /**
     * The type of authentication used for the webhook.
     */
    type!: typeof AuthConfig.API_KEY;
    /**
     * Configuration for API key authentication.
     * This is required if the type is 'apiKey'.
     */
    config!: ApiKeyConfig;
}

export class WebHookAuthConfigNone extends createZodDto(
    WebHookAuthConfigNoneSchema,
) {
    /**
     * The type of authentication used for the webhook.
     */
    type!: typeof AuthConfig.NONE;
}

/**
 * Configuration for webhooks used in various services.
 */
@ApiExtraModels(WebHookAuthConfigNone, WebHookAuthConfigHeader)
export class WebhookConfig
    extends createZodDto(WebhookConfigSchema)
    implements WebhookConfiguration
{
    /**
     * The URL to which the webhook will send notifications.
     */
    url!: string;
    /**
     * Optional authentication configuration for the webhook.
     * If not provided, no authentication will be used.
     */
    @ApiProperty({
        oneOf: [
            { $ref: getSchemaPath(WebHookAuthConfigNone) },
            { $ref: getSchemaPath(WebHookAuthConfigHeader) },
        ],
    })
    auth!: z.infer<typeof WebHookAuthConfigSchema>;

    /**
     * Optional array of credential configuration IDs.
     * If provided, the webhook payload will include the raw cryptographic
     * presentation (e.g., vp_token) for these specific credentials.
     */
    @ApiProperty({
        required: false,
        type: [String],
        description:
            "List of credential IDs to include raw tokens for (e.g., ['sca_credential'])",
    })
    includeRawTokensFor?: string[];
}
