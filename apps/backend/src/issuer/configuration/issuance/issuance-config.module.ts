import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../../audit-log/audit-log.module.js";
import { RegistrarModule } from "../../../registrar/registrar.module.js";
import { CredentialConfigModule } from "../credentials/credential-config.module.js";
import { TypeOrmIssuanceConfigRepository } from "./adapters/typeorm-issuance-config.repository.js";
import { IssuanceConfig } from "./entities/issuance-config.entity.js";
import { IssuanceService } from "./issuance.service.js";
import { IssuanceConfigController } from "./issuance-config.controller.js";
import { ISSUANCE_CONFIG_REPOSITORY } from "./ports/issuance-config.repository.js";

@Module({
    imports: [
        TypeOrmModule.forFeature([IssuanceConfig]),
        AuditLogModule,
        CredentialConfigModule,
        RegistrarModule,
    ],
    controllers: [IssuanceConfigController],
    providers: [
        IssuanceService,
        {
            provide: ISSUANCE_CONFIG_REPOSITORY,
            inject: [getRepositoryToken(IssuanceConfig)],
            useFactory: (repository: Repository<IssuanceConfig>) =>
                new TypeOrmIssuanceConfigRepository(repository),
        },
    ],
    exports: [IssuanceService],
})
export class IssuanceConfigModule {}
