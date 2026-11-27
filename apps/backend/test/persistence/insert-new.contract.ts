import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { expect, it, vi } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { insertNew } from "../../src/database/insert-new.js";
import { WebhookEndpointEntity } from "../../src/issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { ResourceIdTaken } from "../../src/shared/domain/conflict-error.js";
import { TypeOrmFederationTrustAnchorRepository } from "../../src/trust/federation-trust-anchor/adapters/typeorm-federation-trust-anchor.repository.js";
import { FederationTrustAnchorEntity } from "../../src/trust/federation-trust-anchor/entities/federation-trust-anchor.entity.js";
import { PresentationConfig } from "../../src/verifier/presentations/entities/presentation-config.entity.js";

export const insertNewEntities = [
    TenantEntity,
    ClientEntity,
    WebhookEndpointEntity,
    FederationTrustAnchorEntity,
    PresentationConfig,
];

/**
 * `insertNew` and the federation trust anchor adapter on a real database:
 * a second insert of the same (tenantId, id) is refused with
 * ResourceIdTaken, and other unique indexes keep their database error.
 */
export function insertNewContract(database: () => DataSource) {
    it("refuses a second presentation config with the same ID, keeping the first", async () => {
        const db = database();
        const tenantId = randomUUID();
        await db.getRepository(TenantEntity).save({ id: tenantId });
        const repository = db.getRepository(PresentationConfig);
        const config = {
            id: "pid",
            tenantId,
            dcql_query: { credentials: [] },
        } as Partial<PresentationConfig>;
        const taken = () =>
            new ResourceIdTaken("Presentation configuration", "pid");

        const created = await insertNew(
            repository,
            { ...config, description: "first" },
            { id: "pid", tenantId },
            taken,
        );
        // Column defaults the database filled in are on the returned entity.
        expect(created.lifeTime).toBe(300);
        await expect(
            insertNew(
                repository,
                { ...config, description: "second" },
                { id: "pid", tenantId },
                taken,
            ),
        ).rejects.toThrow(taken());
        expect(
            await repository.findOneByOrFail({ id: "pid", tenantId }),
        ).toMatchObject({ description: "first" });
        await db.getRepository(TenantEntity).delete({ id: tenantId });
    });

    it("passes on a database error other than a unique violation", async () => {
        const repository = database().getRepository(PresentationConfig);
        const taken = vi.fn(
            () => new ResourceIdTaken("Presentation configuration", "pid"),
        );
        // No tenant row: the foreign key refuses the insert.
        const tenantId = randomUUID();
        const failed = insertNew(
            repository,
            { id: "pid", tenantId, dcql_query: { credentials: [] } } as never,
            { id: "pid", tenantId },
            taken,
        );
        await expect(failed).rejects.toThrow();
        await expect(failed).rejects.not.toBeInstanceOf(ResourceIdTaken);
        expect(taken).not.toHaveBeenCalled();
    });

    it("refuses a second federation trust anchor with the same ID, and passes on an entity ID clash", async () => {
        const db = database();
        const tenantId = randomUUID();
        await db.getRepository(TenantEntity).save({ id: tenantId });
        const repository = new TypeOrmFederationTrustAnchorRepository(
            db.getRepository(FederationTrustAnchorEntity),
        );
        const anchor = {
            id: "eu",
            tenantId,
            entityId: "https://ta.example.org",
            jwks: { keys: [] } as never,
        };

        await repository.create(anchor);
        expect(await repository.existsForTenant(tenantId, "eu")).toBe(true);
        await expect(
            repository.create({ ...anchor, entityId: "https://other.example" }),
        ).rejects.toThrow(new ResourceIdTaken("Federation trust anchor", "eu"));
        // Another ID with the same entity ID hits the entity ID index: not a
        // taken ID, so the database error is passed on.
        const clash = repository.create({ ...anchor, id: "eu2" });
        await expect(clash).rejects.not.toBeInstanceOf(ResourceIdTaken);
        await expect(clash).rejects.toThrow();
        expect(await repository.findForTenant(tenantId, "eu")).toMatchObject({
            entityId: "https://ta.example.org",
        });
        expect(await repository.existsForTenant(tenantId, "eu2")).toBe(false);
        await db.getRepository(TenantEntity).delete({ id: tenantId });
    });
}
