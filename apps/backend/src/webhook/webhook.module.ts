import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { SessionModule } from "../session/session.module.js";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";
import { PRESENTATION_RESULT_PUBLISHER } from "./ports/presentation-result-publisher.js";
import { WebhookService } from "./webhook.service.js";
import { WebhookPresentationResultPublisher } from "./webhook-presentation-result-publisher.js";

/**
 * Owns outbound webhook delivery and its SSRF protection policy.
 *
 * Consumers import this module instead of registering their own copies of the
 * providers, ensuring the application uses one shared provider instance.
 */
@Module({
    imports: [HttpModule, SessionModule],
    providers: [
        WebhookService,
        OutboundUrlPolicyService,
        WebhookPresentationResultPublisher,
        {
            provide: PRESENTATION_RESULT_PUBLISHER,
            useExisting: WebhookPresentationResultPublisher,
        },
    ],
    exports: [
        WebhookService,
        OutboundUrlPolicyService,
        PRESENTATION_RESULT_PUBLISHER,
    ],
})
export class WebhookModule {}
