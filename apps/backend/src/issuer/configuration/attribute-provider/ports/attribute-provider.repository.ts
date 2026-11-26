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
    /** Whether the tenant has one with this ID, without loading it. */
    existsForTenant(tenantId: string, id: string): Promise<boolean>;
    /**
     * Stores a new one; never replaces a stored one, also not under
     * concurrent creates of the same ID.
     * @throws ResourceIdTaken when the tenant already has one with this ID.
     */
    create(config: AttributeProviderData): Promise<AttributeProviderData>;
    /** Stores it, replacing a stored one with the same ID. */
    save(config: AttributeProviderData): Promise<AttributeProviderData>;
    deleteForTenant(tenantId: string, id: string): Promise<void>;
}
