import { Logger } from "@nestjs/common";
import type { DeepPartial, Repository } from "typeorm";
import {
    type IssuanceConfiguration,
    IssuanceConfigurationNotFound,
} from "../domain/issuance-configuration.js";
import {
    REMOVED_CHAINED_VP_MESSAGE,
    withoutRemovedChainedVp,
} from "../domain/removed-authorization-servers.js";
import type { IssuanceConfig } from "../entities/issuance-config.entity.js";
import type { IssuanceConfigRepository } from "../ports/issuance-config.repository.js";
export class TypeOrmIssuanceConfigRepository
    implements IssuanceConfigRepository
{
    private readonly logger = new Logger(TypeOrmIssuanceConfigRepository.name);
    /** Tenants already warned about removed authorization server entries. */
    private readonly warnedTenants = new Set<string>();

    constructor(private readonly repository: Repository<IssuanceConfig>) {}
    async getForTenant(tenantId: string) {
        const row = await this.repository.findOneBy({ tenantId });
        if (!row) throw new IssuanceConfigurationNotFound(tenantId);
        return this.toData(row);
    }
    async save(config: Partial<IssuanceConfiguration> & { tenantId: string }) {
        return this.toData(
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
    /**
     * Plain model without the tenant relation. Entries of removed
     * authorization server types are skipped so stored configurations keep
     * loading; the next save drops them.
     */
    private toData(row: IssuanceConfig): IssuanceConfiguration {
        const { tenant: _tenant, ...config } = row;
        const data = { ...config } as IssuanceConfiguration;
        if (!Array.isArray(data.authorizationServers)) {
            return data;
        }
        const { servers, changedIds } = withoutRemovedChainedVp(
            data.authorizationServers,
        );
        if (changedIds.length > 0) {
            data.authorizationServers = servers;
            if (!this.warnedTenants.has(data.tenantId)) {
                this.warnedTenants.add(data.tenantId);
                this.logger.warn(
                    `[${data.tenantId}] Ignoring 'vp' of authorization server(s) ${changedIds.map((id) => `'${id}'`).join(", ")}; chained entries without 'upstream' are skipped. ${REMOVED_CHAINED_VP_MESSAGE}`,
                );
            }
        }
        return data;
    }
}
