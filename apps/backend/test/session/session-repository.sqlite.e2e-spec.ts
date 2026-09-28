import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import {
    initializeTestEncryption,
    sessionEntities,
    sessionRepositoryContract,
} from "./session-repository.contract.js";

describe("SQLite session repository", () => {
    let db: DataSource;

    beforeAll(async () => {
        await initializeTestEncryption();
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: sessionEntities,
            synchronize: true,
        }).initialize();
    });

    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });

    sessionRepositoryContract(() => db);
});
