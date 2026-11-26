import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../../audit-log/audit-log.module.js";
import { SecretsModule } from "../../../platform/secrets/secrets.module.js";
import { OutboundUrlPolicyModule } from "../../../webhook/outbound-url-policy.module.js";
import { TypeOrmAttributeProviderRepository } from "./adapters/typeorm-attribute-provider.repository.js";
import { AttributeProviderReferences } from "./application/attribute-provider-references.js";
import { AttributeProviderController } from "./attribute-provider.controller.js";
import { AttributeProviderService } from "./attribute-provider.service.js";
import { AttributeProviderEntity } from "./entities/attribute-provider.entity.js";
import { ATTRIBUTE_PROVIDER_REPOSITORY } from "./ports/attribute-provider.repository.js";

@Module({
    imports: [
        TypeOrmModule.forFeature([AttributeProviderEntity]),
        AuditLogModule,
        OutboundUrlPolicyModule,
        SecretsModule,
    ],
    controllers: [AttributeProviderController],
    providers: [
        AttributeProviderService,
        AttributeProviderReferences,
        {
            provide: ATTRIBUTE_PROVIDER_REPOSITORY,
            inject: [getRepositoryToken(AttributeProviderEntity)],
            useFactory: (repository: Repository<AttributeProviderEntity>) =>
                new TypeOrmAttributeProviderRepository(repository),
        },
    ],
    exports: [
        AttributeProviderService,
        AttributeProviderReferences,
        ATTRIBUTE_PROVIDER_REPOSITORY,
    ],
})
export class AttributeProviderModule {}
