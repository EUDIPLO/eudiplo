import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { expect, it } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TypeOrmTenantRepository } from "../../src/auth/tenant/adapters/typeorm-tenant.repository.js";

export function tenantRepositoryContract(database: () => DataSource) {
    it("maps tenant defaults and policies without exposing client secrets", async () => {
        const db = database();
        const repo = new TypeOrmTenantRepository(
            db.getRepository("TenantEntity"),
        );
        const id = randomUUID();
        const created = await repo.save({ id });
        expect(created).toMatchObject({ id, name: "EUDIPLO", status: null });
        expect(created.constructor).toBe(Object);
        expect(await repo.findActive(id)).toBeNull();
        await repo.update(id, {
            status: "active",
            sessionConfig: { cleanupMode: "anonymize", ttlSeconds: 60 },
        });
        expect(await repo.findActive(id)).toMatchObject({
            sessionConfig: { cleanupMode: "anonymize", ttlSeconds: 60 },
        });
        const clients = db.getRepository(ClientEntity);
        await clients.save({
            clientId: id,
            tenantId: id,
            secret: "secret-hash",
            roles: [],
        });
        const tenant = await repo.getWithClients(id);
        expect(tenant.clients).toHaveLength(1);
        expect(tenant.clients![0]).not.toHaveProperty("secret");
        expect(tenant.clients![0]).not.toHaveProperty("tenant");
        await repo.delete(id);
        expect(await clients.findOneBy({ clientId: id })).toBeNull();
    });

    it("scopes mutations, clears nulls, and reports missing tenants", async () => {
        const repo = new TypeOrmTenantRepository(
            database().getRepository("TenantEntity"),
        );
        const id = randomUUID();
        const other = randomUUID();
        await repo.save({ id, name: "original", description: "description" });
        await repo.save({ id: other, name: "other" });
        await repo.update(id, { description: null });
        expect(await repo.findById(id)).toMatchObject({
            name: "original",
            description: null,
        });
        expect(await repo.findById(other)).toMatchObject({ name: "other" });
        expect((await repo.list()).some((row) => row.id === id)).toBe(true);
        expect(await repo.count()).toBeGreaterThanOrEqual(2);
        await repo.delete(id);
        await repo.delete(id);
        await expect(repo.getWithClients(id)).rejects.toMatchObject({
            name: "TenantNotFound",
            tenantId: id,
        });
        expect(await repo.findById(other)).not.toBeNull();
        await repo.delete(other);
    });
}
