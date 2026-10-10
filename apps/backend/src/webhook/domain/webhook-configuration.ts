export const WebhookAuthType = {
    API_KEY: "apiKey",
    NONE: "none",
} as const;
export type WebhookAuthType =
    (typeof WebhookAuthType)[keyof typeof WebhookAuthType];
export interface WebhookConfiguration {
    url: string;
    auth:
        | {
              type: typeof WebhookAuthType.API_KEY;
              config: { headerName: string; value: string };
          }
        | { type: typeof WebhookAuthType.NONE };
    includeRawTokensFor?: string[];
}

/** Fields of a webhook endpoint or attribute provider in the audit log. */
export const AUDITED_ENDPOINT_FIELDS = [
    "id",
    "name",
    "url",
    "description",
    "auth",
] as const;

/** `auth` with the API key replaced by `[REDACTED]`, for the audit log. */
export function redactWebhookAuth(
    auth: WebhookConfiguration["auth"],
): WebhookConfiguration["auth"] {
    return auth?.type === WebhookAuthType.API_KEY
        ? { ...auth, config: { ...auth.config, value: "[REDACTED]" } }
        : auth;
}
