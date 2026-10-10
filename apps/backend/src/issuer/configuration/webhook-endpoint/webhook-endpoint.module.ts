import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../../audit-log/audit-log.module.js";
import { OutboundUrlPolicyModule } from "../../../webhook/outbound-url-policy.module.js";
import { TypeOrmWebhookEndpointRepository } from "./adapters/typeorm-webhook-endpoint.repository.js";
import { WebhookEndpointEntity } from "./entities/webhook-endpoint.entity.js";
import { WEBHOOK_ENDPOINT_REPOSITORY } from "./ports/webhook-endpoint.repository.js";
import { WebhookEndpointController } from "./webhook-endpoint.controller.js";
import { WebhookEndpointService } from "./webhook-endpoint.service.js";

@Module({
    imports: [
        TypeOrmModule.forFeature([WebhookEndpointEntity]),
        AuditLogModule,
        OutboundUrlPolicyModule,
    ],
    controllers: [WebhookEndpointController],
    providers: [
        WebhookEndpointService,
        {
            provide: WEBHOOK_ENDPOINT_REPOSITORY,
            inject: [getRepositoryToken(WebhookEndpointEntity)],
            useFactory: (repository: Repository<WebhookEndpointEntity>) =>
                new TypeOrmWebhookEndpointRepository(repository),
        },
    ],
    exports: [WebhookEndpointService, WEBHOOK_ENDPOINT_REPOSITORY],
})
export class WebhookEndpointModule {}
