import type { SecretUse } from "../../platform/secrets/domain/secret-use.js";

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
    /**
     * Set only in memory for a stored webhook endpoint or attribute
     * provider, whose API key may be a secret reference that is resolved
     * under the tenant's secret policy when it is sent. A webhook from a
     * request never has it, so its API key is always sent as written.
     */
    storedAs?: StoredWebhook;
}

/** The stored resource a webhook was read from. */
export interface StoredWebhook {
    kind: "WebhookEndpoint" | "AttributeProvider";
    tenantId: string;
}

/**
 * How the API key of a stored webhook is used: by the tenant that owns it,
 * in its `auth.config.value`, sent to `url`. The same for the check before
 * it is stored and the one when it is sent, so the two cannot differ.
 */
export function storedWebhookSecretUse(
    storedAs: StoredWebhook,
    url: string,
): SecretUse {
    return {
        scope: { type: "tenant", tenantId: storedAs.tenantId },
        field: `${storedAs.kind}:auth.config.value`,
        destination: url,
    };
}

/** The webhook of a stored webhook endpoint or attribute provider. */
export function storedWebhook(
    kind: StoredWebhook["kind"],
    entry: {
        tenantId: string;
        url: string;
        auth: WebhookConfiguration["auth"];
    },
): WebhookConfiguration {
    return {
        url: entry.url,
        auth: entry.auth,
        storedAs: { kind, tenantId: entry.tenantId },
    };
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

/**
 * `auth` with the API key replaced by `[REDACTED]`, for the audit log. A key
 * for which `shown` is true, a secret reference, is no secret and kept.
 */
export function redactWebhookAuth(
    auth: WebhookConfiguration["auth"],
    shown: (value: string) => boolean = () => false,
): WebhookConfiguration["auth"] {
    return auth?.type === WebhookAuthType.API_KEY && !shown(auth.config.value)
        ? { ...auth, config: { ...auth.config, value: "[REDACTED]" } }
        : auth;
}
