import type { AttributeProviderReference } from "../domain/attribute-provider-reference.js";

/**
 * Finds the configurations that name an attribute provider. Implemented by
 * the feature that owns those configurations, which registers it with
 * `AttributeProviderReferences`.
 */
export interface AttributeProviderReferenceSource {
    /** Configurations of the tenant that name the attribute provider. */
    findReferences(
        tenantId: string,
        providerId: string,
    ): Promise<AttributeProviderReference[]>;
}
