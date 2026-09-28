import type { AttributeProviderData } from "../domain/attribute-provider-data.js";

export const ATTRIBUTE_PROVIDER_REPOSITORY = Symbol(
    "ATTRIBUTE_PROVIDER_REPOSITORY",
);
export interface AttributeProviderRepository {
    listForTenant(tenantId: string): Promise<AttributeProviderData[]>;
    findForTenant(
        tenantId: string,
        id: string,
    ): Promise<AttributeProviderData | null>;
    save(config: AttributeProviderData): Promise<AttributeProviderData>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
}
