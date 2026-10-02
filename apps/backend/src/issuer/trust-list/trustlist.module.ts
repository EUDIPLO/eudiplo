import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { TrustListRenewalJob } from "./adapters/trust-list-renewal.job.js";
import { TrustList } from "./entities/trust-list.entity.js";
import { TrustListVersion } from "./entities/trust-list-version.entity.js";
import { TrustListPublicController } from "./trust-list-public/trust-list-public.controller.js";
import { TrustListController } from "./trustlist.controller.js";
import { TrustListService } from "./trustlist.service.js";

@Module({
    imports: [
        TypeOrmModule.forFeature([TrustList, TrustListVersion, TenantEntity]),
    ],
    providers: [TrustListService, TrustListRenewalJob],
    controllers: [TrustListController, TrustListPublicController],
    exports: [TrustListService],
})
export class TrustListModule {}
