import { Module } from "@nestjs/common";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { ClientModule } from "../client/client.module.js";
import { TypeOrmTenantRepository } from "./adapters/typeorm-tenant.repository.js";
import { TenantEntity } from "./entities/tenant.entity.js";
import { TENANT_REPOSITORY } from "./ports/tenant.repository.js";
import { TenantController } from "./tenant.controller.js";
import { TenantService } from "./tenant.service.js";

@Module({
    imports: [
        TypeOrmModule.forFeature([TenantEntity]),
        AuditLogModule,
        ClientModule,
        CryptoModule,
        RegistrarModule,
    ],
    providers: [
        TenantService,
        {
            provide: TENANT_REPOSITORY,
            inject: [getRepositoryToken(TenantEntity)],
            useFactory: (repository: Repository<TenantEntity>) =>
                new TypeOrmTenantRepository(repository),
        },
    ],
    controllers: [TenantController],
    exports: [TenantService],
})
export class TenantModule {}
