import { Injectable } from "@nestjs/common";
import type { AttributeProviderReference } from "../domain/attribute-provider-reference.js";
import type { AttributeProviderReferenceSource } from "../ports/attribute-provider-reference-source.js";

/**
 * Collects the configurations that name an attribute provider. The feature
 * that owns credential configs registers a source, so this module does not
 * depend on it.
 */
@Injectable()
export class AttributeProviderReferences {
    private readonly sources: AttributeProviderReferenceSource[] = [];

    register(source: AttributeProviderReferenceSource): void {
        this.sources.push(source);
    }

    async find(
        tenantId: string,
        providerId: string,
    ): Promise<AttributeProviderReference[]> {
        const found = await Promise.all(
            this.sources.map((source) =>
                source.findReferences(tenantId, providerId),
            ),
        );
        return found.flat();
    }
}
