import type { WebhookService } from "../../../../webhook/webhook.service.js";
import type { SessionCredentialClaims } from "../ports/credential-generation-context.js";

export class WebhookSessionCredentialClaims implements SessionCredentialClaims {
    constructor(
        private readonly webhooks: Pick<WebhookService, "sendWebhook">,
    ) {}
    async resolve(
        ...[webhook, session, configurationId]: Parameters<
            SessionCredentialClaims["resolve"]
        >
    ) {
        const response = await this.webhooks.sendWebhook({
            webhook,
            session,
            expectResponse: true,
        });
        return response?.[configurationId]
            ? (response[configurationId] as Record<string, unknown>)
            : undefined;
    }
}
