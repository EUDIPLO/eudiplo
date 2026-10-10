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
const AUDITED_ENDPOINT_FIELDS = [
    "id",
    "name",
    "url",
    "description",
    "auth",
] as const;

type AuditedEndpoint = Partial<
    Record<(typeof AUDITED_ENDPOINT_FIELDS)[number], unknown>
>;

/**
 * Audited fields of a webhook endpoint or attribute provider that differ,
 * compared before the API key is redacted, so that a new key is listed.
 */
export function changedEndpointFields(
    before: AuditedEndpoint,
    after: AuditedEndpoint,
): string[] {
    return AUDITED_ENDPOINT_FIELDS.filter(
        (field) =>
            JSON.stringify(before[field] ?? null) !==
            JSON.stringify(after[field] ?? null),
    );
}

/** `auth` with the API key replaced by `[REDACTED]`, for the audit log. */
export function redactWebhookAuth(
    auth: WebhookConfiguration["auth"],
): WebhookConfiguration["auth"] {
    return auth?.type === WebhookAuthType.API_KEY
        ? { ...auth, config: { ...auth.config, value: "[REDACTED]" } }
        : auth;
}
