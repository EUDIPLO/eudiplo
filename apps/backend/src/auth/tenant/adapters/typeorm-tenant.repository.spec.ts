import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import { endpointEntities } from "../../../../test/persistence/endpoint-repository.contract.js";
import { tenantRepositoryContract } from "../../../../test/persistence/tenant-repository.contract.js";

describe("SQLite tenant repository", () => {
    let db: DataSource;
    beforeAll(async () => {
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: endpointEntities,
            synchronize: true,
        }).initialize();
    });
    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });
    tenantRepositoryContract(() => db);
});
