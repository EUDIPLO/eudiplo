import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { WebhookEndpointModule } from "../issuer/configuration/webhook-endpoint/webhook-endpoint.module.js";
import { SessionModule } from "../session/session.module.js";
import { OutboundUrlPolicyModule } from "./outbound-url-policy.module.js";
import { PRESENTATION_RESULT_PUBLISHER } from "./ports/presentation-result-publisher.js";
import { SessionCancellationWebhookListener } from "./session-cancellation-webhook.listener.js";
import { WebhookService } from "./webhook.service.js";
import { WebhookPresentationResultPublisher } from "./webhook-presentation-result-publisher.js";

/**
 * Owns outbound webhook delivery. It re-exports the outbound URL policy for
 * consumers that also deliver webhooks; modules that only need the policy
 * import OutboundUrlPolicyModule.
 */
@Module({
    imports: [
        HttpModule,
        SessionModule,
        OutboundUrlPolicyModule,
        WebhookEndpointModule,
    ],
    providers: [
        WebhookService,
        SessionCancellationWebhookListener,
        WebhookPresentationResultPublisher,
        {
            provide: PRESENTATION_RESULT_PUBLISHER,
            useExisting: WebhookPresentationResultPublisher,
        },
    ],
    exports: [
        WebhookService,
        OutboundUrlPolicyModule,
        PRESENTATION_RESULT_PUBLISHER,
    ],
})
export class WebhookModule {}
