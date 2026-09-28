import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import type { TenantSessionRetention } from "../domain/session-retention.js";
import type { SessionRetentionPolicies } from "../ports/session-retention-policies.js";

@Injectable()
export class TypeOrmSessionRetentionPolicies
    implements SessionRetentionPolicies
{
    constructor(
        @InjectRepository(TenantEntity)
        private readonly tenants: Repository<TenantEntity>,
    ) {}

    async listForMaintenance(): Promise<TenantSessionRetention[]> {
        const tenants = await this.tenants.find({
            select: { id: true, sessionConfig: true },
        });
        return tenants.map((tenant) => ({
            tenantId: tenant.id,
            ttlSeconds: tenant.sessionConfig?.ttlSeconds,
            cleanupMode: tenant.sessionConfig?.cleanupMode,
        }));
    }
}
