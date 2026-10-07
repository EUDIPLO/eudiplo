import { Inject, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PinoLogger } from "nestjs-pino";
import {
    WEBHOOK_ENDPOINT_REPOSITORY,
    type WebhookEndpointRepository,
} from "../issuer/configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import { SessionStore } from "../session/application/session-store.js";
import {
    SESSION_CANCELLED,
    type SessionCancelledEvent,
} from "../session/ports/session-event-publisher.js";
import type { WebhookConfig } from "./webhook.dto.js";
import { WebhookService } from "./webhook.service.js";

/**
 * Reports a cancelled session to its webhook: the webhook passed with a
 * presentation request, otherwise the webhook endpoint stored on the session.
 * Best effort: the cancellation is already persisted, so a delivery error is
 * only logged.
 */
@Injectable()
export class SessionCancellationWebhookListener {
    constructor(
        private readonly sessionStore: SessionStore,
        private readonly webhooks: WebhookService,
        @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
        private readonly endpoints: Pick<
            WebhookEndpointRepository,
            "findForTenant"
        >,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext("SessionCancellationWebhookListener");
    }

    @OnEvent(SESSION_CANCELLED, { async: true })
    async handleSessionCancelled(event: SessionCancelledEvent): Promise<void> {
        try {
            const session = await this.sessionStore.getForTenant(
                event.tenantId,
                event.sessionId,
            );
            const webhook =
                session.parsedWebhook ??
                (await this.resolveEndpoint(
                    session.tenantId,
                    session.webhookEndpointId,
                ));
            if (!webhook) return;
            await this.webhooks.sendSessionCancelledWebhook(
                webhook,
                session,
                event.reason,
            );
        } catch (error) {
            this.logger.warn(
                {
                    sessionId: event.sessionId,
                    error: error instanceof Error ? error.message : error,
                },
                "Could not report the cancelled session to its webhook",
            );
        }
    }

    private async resolveEndpoint(
        tenantId: string,
        webhookEndpointId: string | undefined,
    ): Promise<WebhookConfig | undefined> {
        if (!webhookEndpointId) return undefined;
        const endpoint = await this.endpoints.findForTenant(
            tenantId,
            webhookEndpointId,
        );
        return endpoint
            ? { url: endpoint.url, auth: endpoint.auth }
            : undefined;
    }
}
