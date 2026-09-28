import { Injectable } from "@nestjs/common";
import type {
    Notification,
    SessionData,
} from "../../../../session/domain/session-data.js";
import type { WebhookConfiguration } from "../../../../webhook/domain/webhook-configuration.js";
import { WebhookService } from "../../../../webhook/webhook.service.js";
import type { CredentialNotificationPublisher } from "../ports/credential-notification-publisher.js";

@Injectable()
export class WebhookCredentialNotificationPublisher
    implements CredentialNotificationPublisher
{
    constructor(private readonly webhooks: WebhookService) {}

    publish(
        configuration: WebhookConfiguration,
        session: SessionData,
        notification: Notification,
    ): Promise<void> {
        return this.webhooks.sendWebhookNotification(
            configuration,
            session,
            notification,
        );
    }
}
