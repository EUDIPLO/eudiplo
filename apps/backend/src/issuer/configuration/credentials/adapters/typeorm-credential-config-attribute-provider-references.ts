import type { Repository } from "typeorm";
import type { AttributeProviderReference } from "../../attribute-provider/domain/attribute-provider-reference.js";
import type { AttributeProviderReferenceSource } from "../../attribute-provider/ports/attribute-provider-reference-source.js";
import type { CredentialConfig } from "../entities/credential.entity.js";

/** Credential configs of the tenant whose `attributeProviderId` names the provider. */
export class TypeOrmCredentialConfigAttributeProviderReferences
    implements AttributeProviderReferenceSource
{
    constructor(private readonly repository: Repository<CredentialConfig>) {}

    async findReferences(
        tenantId: string,
        providerId: string,
    ): Promise<AttributeProviderReference[]> {
        const configs = await this.repository.find({
            where: { tenantId, attributeProviderId: providerId },
            select: { id: true, description: true },
            order: { id: "ASC" },
        });
        return configs.map((config) => ({
            kind: "CredentialConfig",
            id: config.id,
            description: config.description ?? undefined,
        }));
    }
}
