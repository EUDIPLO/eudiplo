import type { CredentialConfiguration } from "../domain/credential-configuration.js";

export const CREDENTIAL_CONFIGURATION_REPOSITORY = Symbol(
    "CREDENTIAL_CONFIGURATION_REPOSITORY",
);

/**
 * Tenant-scoped persistence for credential configurations, shared by
 * configuration management and credential issuance.
 */
export interface CredentialConfigurationRepository {
    /** Lists the tenant's configurations, optionally restricted to `ids`. */
    listForTenant(
        tenantId: string,
        ids?: string[],
    ): Promise<CredentialConfiguration[]>;
    findForTenant(
        tenantId: string,
        id: string,
    ): Promise<CredentialConfiguration | null>;
    /** @throws CredentialConfigurationNotFound */
    getForTenant(
        tenantId: string,
        id: string,
    ): Promise<CredentialConfiguration>;
    /** Whether the tenant has a configuration with this ID, without loading it. */
    existsForTenant(tenantId: string, id: string): Promise<boolean>;
    /**
     * Stores a new configuration; never replaces a stored one, also not
     * under concurrent creates of the same ID.
     * @throws ResourceIdTaken when the tenant has a configuration with this ID.
     */
    create(
        config: Partial<CredentialConfiguration> & {
            id: string;
            tenantId: string;
        },
    ): Promise<CredentialConfiguration>;
    /** Stores a configuration, replacing a stored one with the same ID. */
    save(
        config: Partial<CredentialConfiguration> & {
            id: string;
            tenantId: string;
        },
    ): Promise<CredentialConfiguration>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
}
