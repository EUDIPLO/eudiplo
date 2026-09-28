import type { CredentialConfiguration } from "../../domain/credential-configuration.js";
export const CREDENTIAL_CONFIG_REPOSITORY = Symbol(
    "CREDENTIAL_CONFIG_REPOSITORY",
);
export interface CredentialConfigRepository {
    listForTenant(tenantId: string): Promise<CredentialConfiguration[]>;
    getForTenant(
        tenantId: string,
        id: string,
    ): Promise<CredentialConfiguration>;
    save(
        config: Partial<CredentialConfiguration> & {
            id: string;
            tenantId: string;
        },
    ): Promise<CredentialConfiguration>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
}
