import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { getRepositoryToken, TypeOrmModule } from "@nestjs/typeorm";
import type { Repository } from "typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { provideKeyChainReferenceSource } from "../../crypto/key/key-chain-reference-source.provider.js";
import { RegistrarModule } from "../../registrar/registrar.module.js";
import { ClientModule } from "../client/client.module.js";
import { TypeOrmTenantRepository } from "./adapters/typeorm-tenant.repository.js";
import { TypeOrmTenantKeyChainReferences } from "./adapters/typeorm-tenant-key-chain-references.js";
import { DefaultAccessKeyChainController } from "./default-access-key-chain.controller.js";
import { TenantEntity } from "./entities/tenant.entity.js";
import { KnownTenantGuard } from "./known-tenant.guard.js";
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
        provideKeyChainReferenceSource(
            TypeOrmTenantKeyChainReferences,
            TenantEntity,
        ),
        // Routes with a `:tenantId` parameter answer 404 for unknown tenants.
        { provide: APP_GUARD, useClass: KnownTenantGuard },
    ],
    controllers: [TenantController, DefaultAccessKeyChainController],
    exports: [TenantService],
})
export class TenantModule {}
