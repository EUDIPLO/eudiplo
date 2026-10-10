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
} from "./webhook.schema.js";

export {
    WebHookAuthConfigSchema,
    WebhookConfigSchema,
} from "./webhook.schema.js";

/**
 * Configuration for API key authentication in webhooks.
 */
// Field descriptions come from webhook.schema.ts. Field comments here would
// replace them in OpenAPI (the Swagger plugin reads comments), so the classes
// only declare the types.

export class ApiKeyConfig extends createZodDto(ApiKeyConfigSchema) {
    headerName!: string;
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
    type!: typeof AuthConfig.API_KEY;
    config!: ApiKeyConfig;
}

export class WebHookAuthConfigNone extends createZodDto(
    WebHookAuthConfigNoneSchema,
) {
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
    url!: string;

    @ApiProperty({
        oneOf: [
            { $ref: getSchemaPath(WebHookAuthConfigNone) },
            { $ref: getSchemaPath(WebHookAuthConfigHeader) },
        ],
    })
    auth!: z.infer<typeof WebHookAuthConfigSchema>;

    @ApiProperty({ required: false, type: [String] })
    includeRawTokensFor?: string[];
}
