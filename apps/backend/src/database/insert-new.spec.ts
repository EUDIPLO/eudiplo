import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import {
    insertNewContract,
    insertNewEntities,
} from "../../test/persistence/insert-new.contract.js";
import { initializeTestEncryption } from "../../test/persistence/test-encryption.js";

describe("SQLite insertNew", () => {
    let db: DataSource;
    beforeAll(async () => {
        await initializeTestEncryption();
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: insertNewEntities,
            synchronize: true,
        }).initialize();
    });
    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });
    insertNewContract(() => db);
});
