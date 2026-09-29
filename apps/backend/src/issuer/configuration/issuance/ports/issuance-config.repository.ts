import type { IssuanceConfiguration } from "../domain/issuance-configuration.js";
export const ISSUANCE_CONFIG_REPOSITORY = Symbol("ISSUANCE_CONFIG_REPOSITORY");
export interface IssuanceConfigRepository {
    getForTenant(tenantId: string): Promise<IssuanceConfiguration>;
    save(
        config: Partial<IssuanceConfiguration> & { tenantId: string },
    ): Promise<IssuanceConfiguration>;
    /**
     * Updates only the server-managed registration certificate cache, so a
     * concurrent configuration change is not overwritten.
     * @throws IssuanceConfigurationNotFound
     */
    updateRegistrationCertificateCache(
        tenantId: string,
        cache: IssuanceConfiguration["registrationCertificateCache"],
    ): Promise<void>;
    deleteForTenant(tenantId: string): Promise<void>;
}
