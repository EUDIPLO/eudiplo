import { Injectable } from "@nestjs/common";
import { SessionStatus } from "../session/domain/session-state.js";
import type {
    PresentationResult,
    PresentationResultPublication,
    PresentationResultPublisher,
} from "./ports/presentation-result-publisher.js";
import { WebhookService } from "./webhook.service.js";

@Injectable()
export class WebhookPresentationResultPublisher
    implements PresentationResultPublisher
{
    constructor(private readonly webhooks: WebhookService) {}

    async publish(
        values: PresentationResultPublication,
    ): Promise<PresentationResult> {
        const response = await this.webhooks.sendWebhook({
            webhook: values.webhook,
            session: values.session,
            result: { status: values.status, outcome: values.outcome },
            // Failure results never carry credentials or raw tokens.
            ...(values.status === SessionStatus.Completed
                ? {
                      credentials: values.credentials as any[] | undefined,
                      rawPresentationPayload: values.rawPresentationPayload as
                          | Record<string, unknown>
                          | undefined,
                  }
                : {}),
            expectResponse: false,
        });
        return response?.redirectUri
            ? { redirectUri: response.redirectUri }
            : {};
    }
}
