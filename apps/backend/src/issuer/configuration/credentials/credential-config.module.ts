import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../../audit-log/audit-log.module.js";
import { PresentationsModule } from "../../../verifier/presentations/presentations.module.js";
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
        AuditLogModule,
        PresentationsModule,
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
    ],
    exports: [CredentialConfigService, CREDENTIAL_CONFIGURATION_REPOSITORY],
})
export class CredentialConfigModule {}
