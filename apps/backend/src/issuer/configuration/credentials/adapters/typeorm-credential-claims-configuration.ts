import type { Repository } from "typeorm";
import type { CredentialConfig } from "../entities/credential.entity.js";
import type { CredentialClaimsConfiguration } from "../ports/credential-claims-configuration.js";

export class TypeOrmCredentialClaimsConfiguration
    implements CredentialClaimsConfiguration
{
    constructor(
        private readonly configurations: Repository<CredentialConfig>,
    ) {}
    async findForTenant(tenantId: string, id: string) {
        const config = await this.configurations.findOne({
            where: { tenantId, id },
            select: { id: true, tenantId: true, attributeProviderId: true },
            loadEagerRelations: false,
        });
        return config
            ? { attributeProviderId: config.attributeProviderId }
            : null;
    }
}
