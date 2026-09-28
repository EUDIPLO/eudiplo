import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { expect, it } from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { TypeOrmIssuanceConfigRepository } from "../../src/issuer/configuration/issuance/adapters/typeorm-issuance-config.repository.js";
import { IssuanceConfig } from "../../src/issuer/configuration/issuance/entities/issuance-config.entity.js";

export function issuanceRepositoryContract(database: () => DataSource) {
    it("preserves issuance defaults, JSON and dates in plain tenant-scoped models", async () => {
        const db = database();
        const id = randomUUID();
        const other = randomUUID();
        await db.getRepository(TenantEntity).save([{ id }, { id: other }]);
        const repo = new TypeOrmIssuanceConfigRepository(
            db.getRepository(IssuanceConfig),
        );
        const saved = await repo.save({
            tenantId: id,
            authorizationServers: [{ type: "built-in", id: "local" }],
            display: [],
            federation: null,
        });
        expect(saved.constructor).toBe(Object);
        expect(saved).not.toHaveProperty("tenant");
        expect(saved).toMatchObject({
            tenantId: id,
            batchSize: 1,
            dPopRequired: true,
            notificationEndpointEnabled: true,
            federation: null,
        });
        expect(saved.createdAt).toBeInstanceOf(Date);
        await repo.save({ tenantId: other, batchSize: 9 });
        await repo.save({
            ...saved,
            batchSize: 3,
            registrationCertificateCache: { jwt: "cached", fingerprint: "v1" },
        });
        expect(await repo.getForTenant(id)).toMatchObject({
            batchSize: 3,
            authorizationServers: [{ type: "built-in", id: "local" }],
            registrationCertificateCache: { jwt: "cached", fingerprint: "v1" },
        });
        expect(await repo.getForTenant(other)).toMatchObject({ batchSize: 9 });
        await repo.deleteForTenant(id);
        await repo.deleteForTenant(id);
        await expect(repo.getForTenant(id)).rejects.toMatchObject({
            name: "IssuanceConfigurationNotFound",
            tenantId: id,
        });
        expect(await repo.getForTenant(other)).toMatchObject({ batchSize: 9 });
        await db.getRepository(TenantEntity).delete([{ id }, { id: other }]);
    });
}
