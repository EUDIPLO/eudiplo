import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import {
    endpointEntities,
    endpointRepositoryContract,
} from "../../../../../test/persistence/endpoint-repository.contract.js";
import { initializeTestEncryption } from "../../../../../test/persistence/test-encryption.js";

describe("SQLite webhook-endpoint repository", () => {
    let db: DataSource;
    beforeAll(async () => {
        await initializeTestEncryption();
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
