import { BadRequestException } from "@nestjs/common";
import type { SecretReferences } from "../platform/secrets/application/secret-references.js";
import { assertSecretFieldAllowed } from "../platform/secrets/secret-reference-request.js";
import {
    type StoredWebhook,
    storedWebhookSecretUse,
    type WebhookConfiguration,
} from "./domain/webhook-configuration.js";

/**
 * Checks the API key of a webhook endpoint or attribute provider before it
 * is stored: a secret reference must be one the tenant's secret policy
 * lets this field name for this URL. A literal key passes.
 *
 * @throws BadRequestException naming the reference and why it is refused
 */
export function assertStoredWebhookSecret(
    secrets: SecretReferences,
    kind: StoredWebhook["kind"],
    tenantId: string,
    entry: { url: string; auth?: WebhookConfiguration["auth"] },
): void {
    if (entry.auth?.type !== "apiKey") return;
    assertSecretFieldAllowed(
        secrets,
        entry.auth.config.value,
        storedWebhookSecretUse({ kind, tenantId }, entry.url),
        "auth.config.value",
    );
}

/**
 * Refuses a secret reference as the API key of a webhook in a session
 * request, while a secret policy is set. Such a webhook is written by an
 * API client, which also picks its URL, so its key is always sent as
 * written; a stored webhook endpoint or attribute provider is the place for
 * a reference.
 *
 * @throws BadRequestException naming `path`
 */
export function assertNoRequestWebhookReference(
    secrets: SecretReferences,
    webhook: Pick<WebhookConfiguration, "auth"> | undefined,
    path: string,
): void {
    if (
        webhook?.auth?.type === "apiKey" &&
        secrets.isReference(webhook.auth.config.value)
    )
        throw new BadRequestException(
            `${path}.auth.config.value: a webhook in a request cannot use a secret reference; configure a webhook endpoint or attribute provider and refer to it by ID`,
        );
}
