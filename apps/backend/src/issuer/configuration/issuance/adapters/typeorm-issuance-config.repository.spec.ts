import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpointEntities } from "../../../../../test/persistence/endpoint-repository.contract.js";
import { issuanceRepositoryContract } from "../../../../../test/persistence/issuance-repository.contract.js";
import { TenantEntity } from "../../../../auth/tenant/entities/tenant.entity.js";
import { IssuanceConfig } from "../entities/issuance-config.entity.js";
import { TypeOrmIssuanceConfigRepository } from "./typeorm-issuance-config.repository.js";

describe("SQLite issuance repository", () => {
    let db: DataSource;
    beforeAll(async () => {
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [...endpointEntities, IssuanceConfig],
            synchronize: true,
        }).initialize();
    });
    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });
    issuanceRepositoryContract(() => db);

    it("loads stored configurations with the removed chained 'vp' option", async () => {
        const tenantId = randomUUID();
        await db.getRepository(TenantEntity).save({ id: tenantId });
        const upstream = { issuer: "https://idp.example", clientId: "c" };
        const vp = { enabled: true, presentationConfigId: "pid" };
        // Written directly, as stored before EUDIPLO 9.0.
        await db.getRepository(IssuanceConfig).save({
            tenantId,
            authorizationServers: [
                { type: "built-in", id: "built-in" },
                { type: "chained", id: "legacy-vp", vp },
                { type: "chained", id: "chained", upstream, vp },
            ],
            display: [],
        } as unknown as IssuanceConfig);
        const repo = new TypeOrmIssuanceConfigRepository(
            db.getRepository(IssuanceConfig),
        );

        expect(
            (await repo.getForTenant(tenantId)).authorizationServers,
        ).toEqual([
            { type: "built-in", id: "built-in" },
            { type: "chained", id: "chained", upstream },
        ]);
        await db.getRepository(TenantEntity).delete({ id: tenantId });
    });
});
