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

    it("stores upstream client secrets of chained servers encrypted", async () => {
        const db = database();
        const id = randomUUID();
        await db.getRepository(TenantEntity).save({ id });
        const repo = new TypeOrmIssuanceConfigRepository(
            db.getRepository(IssuanceConfig),
        );
        const upstream = {
            issuer: "https://idp.example",
            clientId: "client",
            clientSecret: "upstream-secret",
        };
        const chained = { type: "chained" as const, id: "chained", upstream };
        await repo.save({
            tenantId: id,
            authorizationServers: [{ type: "built-in", id: "local" }, chained],
        });

        expect(
            (await repo.getForTenant(id)).authorizationServers?.[1],
        ).toMatchObject({ upstream });
        const row = await db
            .getRepository(IssuanceConfig)
            .createQueryBuilder("config")
            .select("config.authorizationServers", "servers")
            .where("config.tenantId = :id", { id })
            .getRawOne();
        // SQLite returns the JSON text, PostgreSQL the parsed value.
        const [, stored] =
            typeof row.servers === "string"
                ? JSON.parse(row.servers)
                : row.servers;
        expect(stored.upstream.clientId).toBe("client");
        expect(stored.upstream.clientSecret).not.toBe("upstream-secret");
        await repo.deleteForTenant(id);
        await db.getRepository(TenantEntity).delete({ id });
    });

    it("updates the registration certificate cache without overwriting other settings", async () => {
        const db = database();
        const id = randomUUID();
        await db.getRepository(TenantEntity).save({ id });
        const repo = new TypeOrmIssuanceConfigRepository(
            db.getRepository(IssuanceConfig),
        );
        await repo.save({ tenantId: id, batchSize: 1 });
        // An admin changes the configuration after a cache refresh started.
        await repo.save({
            ...(await repo.getForTenant(id)),
            batchSize: 7,
            authorizationServers: [{ type: "built-in", id: "local" }],
        });
        await repo.updateRegistrationCertificateCache(id, {
            jwt: "cached",
            fingerprint: "v2",
        });

        expect(await repo.getForTenant(id)).toMatchObject({
            batchSize: 7,
            authorizationServers: [{ type: "built-in", id: "local" }],
            registrationCertificateCache: { jwt: "cached", fingerprint: "v2" },
        });
        await expect(
            repo.updateRegistrationCertificateCache(randomUUID(), undefined),
        ).rejects.toThrow();
    });
}
