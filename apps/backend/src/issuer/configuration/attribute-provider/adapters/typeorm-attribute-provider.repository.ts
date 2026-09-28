import type { Repository } from "typeorm";
import type { AttributeProviderData } from "../domain/attribute-provider-data.js";
import type { AttributeProviderEntity } from "../entities/attribute-provider.entity.js";
import type { AttributeProviderRepository } from "../ports/attribute-provider.repository.js";

export class TypeOrmAttributeProviderRepository
    implements AttributeProviderRepository
{
    constructor(
        private readonly repository: Repository<AttributeProviderEntity>,
    ) {}

    async listForTenant(tenantId: string): Promise<AttributeProviderData[]> {
        return (await this.repository.find({ where: { tenantId } })).map(
            (config) => this.toData(config),
        );
    }

    async findForTenant(
        tenantId: string,
        id: string,
    ): Promise<AttributeProviderData | null> {
        const config = await this.repository.findOneBy({ id, tenantId });
        return config ? this.toData(config) : null;
    }

    async save(config: AttributeProviderData): Promise<AttributeProviderData> {
        return this.toData(await this.repository.save(config));
    }

    async deleteForTenant(tenantId: string, id: string): Promise<void> {
        await this.repository.delete({ id, tenantId });
    }

    private toData(config: AttributeProviderEntity): AttributeProviderData {
        return {
            id: config.id,
            tenantId: config.tenantId,
            name: config.name,
            description: config.description,
            url: config.url,
            auth: config.auth,
        };
    }
}
