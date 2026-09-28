import type { Repository } from "typeorm";
import {
    type TenantData,
    TenantNotFound,
    type TenantUpdate,
} from "../domain/tenant-data.js";
import type { TenantEntity } from "../entities/tenant.entity.js";
import type { TenantRepository } from "../ports/tenant.repository.js";

export class TypeOrmTenantRepository implements TenantRepository {
    constructor(private readonly repository: Repository<TenantEntity>) {}
    count() {
        return this.repository.count();
    }
    async list() {
        return (await this.repository.find()).map(toTenantData);
    }
    async findActive(id: string) {
        const row = await this.repository.findOneBy({ id, status: "active" });
        return row ? toTenantData(row) : null;
    }
    async findById(id: string) {
        const row = await this.repository.findOneBy({ id });
        return row ? toTenantData(row) : null;
    }
    async getWithClients(id: string) {
        const row = await this.repository.findOne({
            where: { id },
            relations: { clients: true },
        });
        if (!row) throw new TenantNotFound(id);
        return toTenantData(row);
    }
    async save(tenant: TenantUpdate & { id: string }) {
        return toTenantData(await this.repository.save(tenant));
    }
    async update(id: string, data: TenantUpdate) {
        await this.repository.update({ id }, data);
    }
    async delete(id: string) {
        await this.repository.delete({ id });
    }
}
function toTenantData(row: TenantEntity): TenantData {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        sessionConfig: row.sessionConfig,
        statusListConfig: row.statusListConfig,
        ...(row.clients
            ? {
                  clients: row.clients.map((client) => ({
                      clientId: client.clientId,
                      tenantId: client.tenantId,
                      description: client.description,
                      roles: client.roles,
                      allowedPresentationConfigs:
                          client.allowedPresentationConfigs,
                      allowedIssuanceConfigs: client.allowedIssuanceConfigs,
                  })),
              }
            : {}),
    };
}
