import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import { endpointEntities } from "../../../../../test/persistence/endpoint-repository.contract.js";
import { issuanceRepositoryContract } from "../../../../../test/persistence/issuance-repository.contract.js";
import { IssuanceConfig } from "../entities/issuance-config.entity.js";

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
});
