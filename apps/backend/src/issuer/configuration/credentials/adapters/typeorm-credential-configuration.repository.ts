import { In, type Repository } from "typeorm";
import { TypeOrmAttributeProviderRepository } from "../../attribute-provider/adapters/typeorm-attribute-provider.repository.js";
import type { AttributeProviderEntity } from "../../attribute-provider/entities/attribute-provider.entity.js";
import { CredentialConfigurationNotFound } from "../domain/credential-configuration.js";
import type { CredentialConfig } from "../entities/credential.entity.js";
import type { CredentialConfigurationRepository } from "../ports/credential-configuration.repository.js";
import { toCredentialConfiguration } from "./credential-configuration-mapping.js";
export class TypeOrmCredentialConfigurationRepository
    implements CredentialConfigurationRepository
{
    constructor(
        private readonly repository: Repository<CredentialConfig>,
        private readonly providers: Repository<AttributeProviderEntity>,
    ) {}
    async listForTenant(tenantId: string, ids?: string[]) {
        return (
            await this.repository.findBy({
                tenantId,
                ...(ids ? { id: In(ids) } : {}),
            })
        ).map(toCredentialConfiguration);
    }
    async findForTenant(tenantId: string, id: string) {
        const row = await this.repository.findOneBy({ tenantId, id });
        return row ? toCredentialConfiguration(row) : null;
    }
    async getForTenant(tenantId: string, id: string) {
        const row = await this.findForTenant(tenantId, id);
        if (!row) throw new CredentialConfigurationNotFound(tenantId, id);
        return row;
    }
    findAttributeProvider(tenantId: string, id: string) {
        return new TypeOrmAttributeProviderRepository(
            this.providers,
        ).findForTenant(tenantId, id);
    }
}
