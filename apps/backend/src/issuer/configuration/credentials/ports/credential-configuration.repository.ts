import type { AttributeProviderData } from "../../attribute-provider/domain/attribute-provider-data.js";
import type { CredentialConfiguration } from "../domain/credential-configuration.js";
export const CREDENTIAL_CONFIGURATION_REPOSITORY = Symbol(
    "CREDENTIAL_CONFIGURATION_REPOSITORY",
);
export interface CredentialConfigurationRepository {
    listForTenant(
        tenantId: string,
        ids?: string[],
    ): Promise<CredentialConfiguration[]>;
    findForTenant(
        tenantId: string,
        id: string,
    ): Promise<CredentialConfiguration | null>;
    getForTenant(
        tenantId: string,
        id: string,
    ): Promise<CredentialConfiguration>;
    findAttributeProvider(
        tenantId: string,
        id: string,
    ): Promise<AttributeProviderData | null>;
}
