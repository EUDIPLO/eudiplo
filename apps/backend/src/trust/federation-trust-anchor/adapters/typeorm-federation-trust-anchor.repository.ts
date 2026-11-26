import { In, type Repository } from "typeorm";
import { insertNew } from "../../../database/insert-new.js";
import { ResourceIdTaken } from "../../../shared/domain/conflict-error.js";
import type { FederationTrustAnchorData } from "../domain/federation-trust-anchor-data.js";
import type { FederationTrustAnchorEntity } from "../entities/federation-trust-anchor.entity.js";
import type { FederationTrustAnchorRepository } from "../ports/federation-trust-anchor.repository.js";

export class TypeOrmFederationTrustAnchorRepository
    implements FederationTrustAnchorRepository
{
    constructor(
        private readonly repository: Repository<FederationTrustAnchorEntity>,
    ) {}

    async listForTenant(
        tenantId: string,
    ): Promise<FederationTrustAnchorData[]> {
        return (await this.repository.find({ where: { tenantId } })).map(
            toData,
        );
    }

    async findForTenant(
        tenantId: string,
        id: string,
    ): Promise<FederationTrustAnchorData | null> {
        const anchor = await this.repository.findOneBy({ id, tenantId });
        return anchor ? toData(anchor) : null;
    }

    async findByEntityIds(
        tenantId: string,
        entityIds: string[],
    ): Promise<FederationTrustAnchorData[]> {
        if (entityIds.length === 0) return [];
        return (
            await this.repository.findBy({ tenantId, entityId: In(entityIds) })
        ).map(toData);
    }

    existsForTenant(tenantId: string, id: string): Promise<boolean> {
        return this.repository.existsBy({ id, tenantId });
    }

    async create(
        anchor: FederationTrustAnchorData,
    ): Promise<FederationTrustAnchorData> {
        return toData(
            await insertNew<FederationTrustAnchorEntity>(
                this.repository,
                anchor,
                { id: anchor.id, tenantId: anchor.tenantId },
                () => new ResourceIdTaken("Federation trust anchor", anchor.id),
            ),
        );
    }

    async save(
        anchor: FederationTrustAnchorData,
    ): Promise<FederationTrustAnchorData> {
        return toData(await this.repository.save(anchor));
    }

    async deleteForTenant(tenantId: string, id: string): Promise<void> {
        await this.repository.delete({ id, tenantId });
    }
}

function toData(
    anchor: FederationTrustAnchorEntity,
): FederationTrustAnchorData {
    return {
        id: anchor.id,
        tenantId: anchor.tenantId,
        entityId: anchor.entityId,
        description: anchor.description,
        jwks: anchor.jwks,
    };
}
