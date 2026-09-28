import type { DeepPartial, Repository } from "typeorm";
import { toCredentialConfiguration } from "../../adapters/credential-configuration-mapping.js";
import {
    type CredentialConfiguration,
    CredentialConfigurationNotFound,
} from "../../domain/credential-configuration.js";
import type { CredentialConfig } from "../../entities/credential.entity.js";
import type { CredentialConfigRepository } from "../ports/credential-config.repository.js";
export class TypeOrmCredentialConfigRepository
    implements CredentialConfigRepository
{
    constructor(private readonly repository: Repository<CredentialConfig>) {}
    async listForTenant(tenantId: string) {
        return (await this.repository.findBy({ tenantId })).map(
            toCredentialConfiguration,
        );
    }
    async getForTenant(tenantId: string, id: string) {
        const row = await this.repository.findOneBy({ tenantId, id });
        if (!row) throw new CredentialConfigurationNotFound(tenantId, id);
        return toCredentialConfiguration(row);
    }
    async save(
        config: Partial<CredentialConfiguration> & {
            id: string;
            tenantId: string;
        },
    ) {
        return toCredentialConfiguration(
            await this.repository.save(config as DeepPartial<CredentialConfig>),
        );
    }
    async deleteForTenant(tenantId: string, id: string) {
        await this.repository.delete({ tenantId, id });
    }
}
