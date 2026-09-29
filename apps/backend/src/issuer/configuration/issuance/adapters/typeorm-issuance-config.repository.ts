import type { DeepPartial, Repository } from "typeorm";
import {
    type IssuanceConfiguration,
    IssuanceConfigurationNotFound,
} from "../domain/issuance-configuration.js";
import type { IssuanceConfig } from "../entities/issuance-config.entity.js";
import type { IssuanceConfigRepository } from "../ports/issuance-config.repository.js";
export class TypeOrmIssuanceConfigRepository
    implements IssuanceConfigRepository
{
    constructor(private readonly repository: Repository<IssuanceConfig>) {}
    async getForTenant(tenantId: string) {
        const row = await this.repository.findOneBy({ tenantId });
        if (!row) throw new IssuanceConfigurationNotFound(tenantId);
        return toData(row);
    }
    async save(config: Partial<IssuanceConfiguration> & { tenantId: string }) {
        return toData(
            await this.repository.save(config as DeepPartial<IssuanceConfig>),
        );
    }
    async updateRegistrationCertificateCache(
        tenantId: string,
        cache: IssuanceConfiguration["registrationCertificateCache"],
    ) {
        const result = await this.repository.update(
            { tenantId },
            {
                registrationCertificateCache:
                    cache as IssuanceConfig["registrationCertificateCache"],
            },
        );
        if (!result.affected) throw new IssuanceConfigurationNotFound(tenantId);
    }
    async deleteForTenant(tenantId: string) {
        await this.repository.delete({ tenantId });
    }
}
function toData(row: IssuanceConfig): IssuanceConfiguration {
    const { tenant: _tenant, ...config } = row;
    return { ...config } as IssuanceConfiguration;
}
