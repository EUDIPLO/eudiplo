import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../../audit-log/audit-log.module.js";
import { PresentationsModule } from "../../../verifier/presentations/presentations.module.js";
import { TypeOrmCredentialConfigRepository } from "./credential-config/adapters/typeorm-credential-config.repository.js";
import { CredentialConfigService } from "./credential-config/credential-config.service.js";
import { CREDENTIAL_CONFIG_REPOSITORY } from "./credential-config/ports/credential-config.repository.js";
import { CredentialConfigController } from "./credential-config.controller.js";
import { CredentialConfig } from "./entities/credential.entity.js";

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
            provide: CREDENTIAL_CONFIG_REPOSITORY,
            inject: [getRepositoryToken(CredentialConfig)],
            useFactory: (repository: Repository<CredentialConfig>) =>
                new TypeOrmCredentialConfigRepository(repository),
        },
    ],
    exports: [CredentialConfigService],
})
export class CredentialConfigModule {}
