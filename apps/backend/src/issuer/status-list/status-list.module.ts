import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../../audit-log/audit-log.module.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { CryptoModule } from "../../crypto/crypto.module.js";
import { ActiveCredentialSlot } from "./entities/active-credential-slot.entity.js";
import { StatusListEntity } from "./entities/status-list.entity.js";
import { StatusMapping } from "./entities/status-mapping.entity.js";
import { StatusListController } from "./status-list.controller.js";
import { StatusListService } from "./status-list.service.js";
import { StatusListConfigController } from "./status-list-config.controller.js";
import { StatusListConfigService } from "./status-list-config.service.js";
import { StatusListManagementController } from "./status-list-management.controller.js";
import { STATUS_LIST_SETTINGS } from "./status-list-settings.js";
import { SubjectKeyService } from "./subject-key.service.js";

@Module({
    imports: [
        CryptoModule,
        AuditLogModule,
        TypeOrmModule.forFeature([
            StatusMapping,
            StatusListEntity,
            TenantEntity,
            ActiveCredentialSlot,
        ]),
    ],
    controllers: [
        StatusListController,
        StatusListConfigController,
        StatusListManagementController,
    ],
    providers: [
        StatusListService,
        StatusListConfigService,
        SubjectKeyService,
        {
            provide: STATUS_LIST_SETTINGS,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                publicUrl: config.getOrThrow<string>("PUBLIC_URL"),
                statusCapacity: config.getOrThrow<number>("STATUS_CAPACITY"),
                statusBits: config.getOrThrow("STATUS_BITS"),
            }),
        },
    ],
    exports: [StatusListService, StatusListConfigService, SubjectKeyService],
})
export class StatusListModule {}
