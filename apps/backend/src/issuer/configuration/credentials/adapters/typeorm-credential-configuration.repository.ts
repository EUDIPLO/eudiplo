import { type DeepPartial, In, type Repository } from "typeorm";
import { insertNew } from "../../../../database/insert-new.js";
import { ResourceIdTaken } from "../../../../shared/domain/conflict-error.js";
import {
    type CredentialConfiguration,
    CredentialConfigurationNotFound,
} from "../domain/credential-configuration.js";
import type { CredentialConfig } from "../entities/credential.entity.js";
import type { CredentialConfigurationRepository } from "../ports/credential-configuration.repository.js";

/** Returns a plain domain object without the entity's TypeORM relations. */
function toCredentialConfiguration(
    row: CredentialConfig,
): CredentialConfiguration {
    const {
        tenant: _tenant,
        keyChain: _keyChain,
        attributeProvider: _attributeProvider,
        webhookEndpoint: _webhookEndpoint,
        ...data
    } = row;
    return { ...data } as CredentialConfiguration;
}

export class TypeOrmCredentialConfigurationRepository
    implements CredentialConfigurationRepository
{
    constructor(private readonly repository: Repository<CredentialConfig>) {}

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

    existsForTenant(tenantId: string, id: string) {
        return this.repository.existsBy({ tenantId, id });
    }

    async create(
        config: Partial<CredentialConfiguration> & {
            id: string;
            tenantId: string;
        },
    ) {
        return toCredentialConfiguration(
            await insertNew(
                this.repository,
                config as DeepPartial<CredentialConfig>,
                { tenantId: config.tenantId, id: config.id },
                () =>
                    new ResourceIdTaken("Credential configuration", config.id),
            ),
        );
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
