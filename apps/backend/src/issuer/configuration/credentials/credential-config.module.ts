import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../../audit-log/audit-log.module.js";
import { provideKeyChainReferenceSource } from "../../../crypto/key/key-chain-reference-source.provider.js";
import { PresentationsModule } from "../../../verifier/presentations/presentations.module.js";
import { provideTrustListReferenceSource } from "../../trust-list/trust-list-reference-source.provider.js";
import { TrustListModule } from "../../trust-list/trustlist.module.js";
import { AttributeProviderModule } from "../attribute-provider/attribute-provider.module.js";
import { provideAttributeProviderReferenceSource } from "../attribute-provider/attribute-provider-reference-source.provider.js";
import { TypeOrmCredentialConfigAttributeProviderReferences } from "./adapters/typeorm-credential-config-attribute-provider-references.js";
import { TypeOrmCredentialConfigKeyChainReferences } from "./adapters/typeorm-credential-config-key-chain-references.js";
import { TypeOrmCredentialConfigTrustListReferences } from "./adapters/typeorm-credential-config-trust-list-references.js";
import { TypeOrmCredentialConfigurationRepository } from "./adapters/typeorm-credential-configuration.repository.js";
import { CredentialConfigService } from "./credential-config/credential-config.service.js";
import { CredentialConfigController } from "./credential-config.controller.js";
import { CredentialConfig } from "./entities/credential.entity.js";
import { CREDENTIAL_CONFIGURATION_REPOSITORY } from "./ports/credential-configuration.repository.js";

/**
 * Owns credential configuration persistence: the management API and the
 * single repository port shared with credential issuance.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([CredentialConfig]),
        AttributeProviderModule,
        AuditLogModule,
        PresentationsModule,
        TrustListModule,
    ],
    controllers: [CredentialConfigController],
    providers: [
        CredentialConfigService,
        {
            provide: CREDENTIAL_CONFIGURATION_REPOSITORY,
            inject: [getRepositoryToken(CredentialConfig)],
            useFactory: (repository: Repository<CredentialConfig>) =>
                new TypeOrmCredentialConfigurationRepository(repository),
        },
        provideTrustListReferenceSource(
            TypeOrmCredentialConfigTrustListReferences,
            CredentialConfig,
        ),
        provideKeyChainReferenceSource(
            TypeOrmCredentialConfigKeyChainReferences,
            CredentialConfig,
        ),
        provideAttributeProviderReferenceSource(
            TypeOrmCredentialConfigAttributeProviderReferences,
            CredentialConfig,
        ),
    ],
    exports: [CredentialConfigService, CREDENTIAL_CONFIGURATION_REPOSITORY],
})
export class CredentialConfigModule {}
