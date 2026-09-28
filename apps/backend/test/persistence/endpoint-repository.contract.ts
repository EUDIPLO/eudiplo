import type { DataSource } from "typeorm";
import { beforeEach, describe, expect, it } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { TypeOrmAttributeProviderRepository } from "../../src/issuer/configuration/attribute-provider/adapters/typeorm-attribute-provider.repository.js";
import { AttributeProviderEntity } from "../../src/issuer/configuration/attribute-provider/entities/attribute-provider.entity.js";
import type { AttributeProviderRepository } from "../../src/issuer/configuration/attribute-provider/ports/attribute-provider.repository.js";
import { TypeOrmWebhookEndpointRepository } from "../../src/issuer/configuration/webhook-endpoint/adapters/typeorm-webhook-endpoint.repository.js";
import { WebhookEndpointEntity } from "../../src/issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";

export const endpointEntities = [
    TenantEntity,
    ClientEntity,
    AttributeProviderEntity,
    WebhookEndpointEntity,
];

export function endpointRepositoryContract(
    getDb: () => DataSource,
    kind: "attribute-provider" | "webhook-endpoint",
) {
    describe(kind + " repository contract", () => {
        let adapter: AttributeProviderRepository;
        const entity =
            kind === "attribute-provider"
                ? AttributeProviderEntity
                : WebhookEndpointEntity;
        const config = {
            id: "shared",
            tenantId: "tenant-a",
            name: "Endpoint",
            url: "https://endpoint.example",
            auth: {
                type: "apiKey" as const,
                config: { headerName: "X-Key", value: "secret" },
            },
        };
        beforeEach(async () => {
            const db = getDb();
            await db.getRepository(entity).clear();
            await db
                .getRepository(TenantEntity)
                .save([{ id: "tenant-a" }, { id: "tenant-b" }]);
            adapter =
                kind === "attribute-provider"
                    ? new TypeOrmAttributeProviderRepository(
                          db.getRepository(AttributeProviderEntity),
                      )
                    : new TypeOrmWebhookEndpointRepository(
                          db.getRepository(WebhookEndpointEntity),
                      );
        });

        it("returns plain values and preserves stored JSON auth and nullable fields", async () => {
            const saved = await adapter.save(config);
            expect(saved).not.toBeInstanceOf(entity);
            expect(saved).toMatchObject(config);
            const loaded = await adapter.findForTenant("tenant-a", config.id);
            const persisted = await getDb()
                .getRepository(entity)
                .findOneByOrFail({ id: config.id, tenantId: "tenant-a" });
            expect(loaded).not.toBeInstanceOf(entity);
            expect(loaded).toEqual({ ...config, description: null });
            expect(JSON.parse(JSON.stringify(loaded))).toEqual(
                JSON.parse(JSON.stringify(persisted)),
            );
            expect(loaded).not.toHaveProperty("tenant");
        });

        it("isolates identical IDs across tenants for reads, updates and deletes", async () => {
            await adapter.save(config);
            await adapter.save({
                ...config,
                tenantId: "tenant-b",
                name: "Other tenant",
            });
            expect(await adapter.listForTenant("tenant-a")).toMatchObject([
                { name: "Endpoint", tenantId: "tenant-a" },
            ]);
            expect(
                await adapter.findForTenant("missing-tenant", config.id),
            ).toBeNull();
            await adapter.save({ ...config, name: "Changed" });
            expect(
                await adapter.findForTenant("tenant-b", config.id),
            ).toMatchObject({ name: "Other tenant" });
            await adapter.deleteForTenant("tenant-a", config.id);
            expect(
                await adapter.findForTenant("tenant-a", config.id),
            ).toBeNull();
            expect(
                await adapter.findForTenant("tenant-b", config.id),
            ).toMatchObject({ name: "Other tenant" });
            await expect(
                adapter.deleteForTenant("tenant-a", config.id),
            ).resolves.toBeUndefined();
        });

        it("preserves merged descriptions and clears explicit nulls on save", async () => {
            await adapter.save({ ...config, description: "description" });
            const existing = await adapter.findForTenant("tenant-a", config.id);
            await adapter.save({ ...existing!, name: "Updated" });
            expect(
                await adapter.findForTenant("tenant-a", config.id),
            ).toMatchObject({ description: "description", name: "Updated" });
            await adapter.save({
                ...config,
                description: null,
                auth: { type: "none" },
            });
            expect(
                await adapter.findForTenant("tenant-a", config.id),
            ).toMatchObject({ description: null, auth: { type: "none" } });
        });
    });
}
