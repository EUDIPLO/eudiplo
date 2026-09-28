import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import {
    endpointEntities,
    endpointRepositoryContract,
} from "../../../../../test/persistence/endpoint-repository.contract.js";

describe("SQLite webhook-endpoint repository", () => {
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
    endpointRepositoryContract(() => db, "webhook-endpoint");
});
