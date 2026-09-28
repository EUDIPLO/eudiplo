import type { IssuanceConfiguration } from "../domain/issuance-configuration.js";
export const ISSUANCE_CONFIG_REPOSITORY = Symbol("ISSUANCE_CONFIG_REPOSITORY");
export interface IssuanceConfigRepository {
    getForTenant(tenantId: string): Promise<IssuanceConfiguration>;
    save(
        config: Partial<IssuanceConfiguration> & { tenantId: string },
    ): Promise<IssuanceConfiguration>;
    deleteForTenant(tenantId: string): Promise<void>;
}
