import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import {
    credentialEntities,
    credentialRepositoryContract,
} from "../../../../../test/persistence/credential-repository.contract.js";

describe("SQLite credential repositories", () => {
    let db: DataSource;
    beforeAll(async () => {
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: credentialEntities,
            synchronize: true,
        }).initialize();
    });
    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });
    credentialRepositoryContract(() => db);
});
