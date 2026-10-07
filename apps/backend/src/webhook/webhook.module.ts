import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { TypeOrmWebhookEndpointRepository } from "../issuer/configuration/webhook-endpoint/adapters/typeorm-webhook-endpoint.repository.js";
import { WebhookEndpointEntity } from "../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { WEBHOOK_ENDPOINT_REPOSITORY } from "../issuer/configuration/webhook-endpoint/ports/webhook-endpoint.repository.js";
import { SessionModule } from "../session/session.module.js";
import { OutboundUrlPolicyModule } from "./outbound-url-policy.module.js";
import { PRESENTATION_RESULT_PUBLISHER } from "./ports/presentation-result-publisher.js";
import { SessionCancellationWebhookListener } from "./session-cancellation-webhook.listener.js";
import { WebhookService } from "./webhook.service.js";
import { WebhookPresentationResultPublisher } from "./webhook-presentation-result-publisher.js";

/**
 * Owns outbound webhook delivery and its SSRF protection policy.
 *
 * Consumers import this module instead of registering their own copies of the
 * providers, ensuring the application uses one shared provider instance.
 */
@Module({
    imports: [
        HttpModule,
        SessionModule,
        OutboundUrlPolicyModule,
        TypeOrmModule.forFeature([WebhookEndpointEntity]),
    ],
    providers: [
        WebhookService,
        SessionCancellationWebhookListener,
        // WebhookEndpointModule imports this module, so the port is provided
        // here instead of importing it back.
        {
            provide: WEBHOOK_ENDPOINT_REPOSITORY,
            inject: [getRepositoryToken(WebhookEndpointEntity)],
            useFactory: (repository: Repository<WebhookEndpointEntity>) =>
                new TypeOrmWebhookEndpointRepository(repository),
        },
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
