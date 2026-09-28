import { Injectable } from "@nestjs/common";
import type { SessionData } from "../session/domain/session-data.js";
import type { WebhookConfiguration } from "./domain/webhook-configuration.js";
import type {
    PresentationResult,
    PresentationResultPublisher,
} from "./ports/presentation-result-publisher.js";
import { WebhookService } from "./webhook.service.js";

@Injectable()
export class WebhookPresentationResultPublisher
    implements PresentationResultPublisher
{
    constructor(private readonly webhooks: WebhookService) {}

    async publish(values: {
        webhook: WebhookConfiguration;
        session: SessionData;
        credentials?: unknown[];
        rawPresentationPayload?: unknown;
    }): Promise<PresentationResult> {
        const response = await this.webhooks.sendWebhook({
            ...values,
            credentials: values.credentials as any[] | undefined,
            rawPresentationPayload: values.rawPresentationPayload as
                | Record<string, unknown>
                | undefined,
            expectResponse: false,
        });
        return response?.redirectUri
            ? { redirectUri: response.redirectUri }
            : {};
    }
}
