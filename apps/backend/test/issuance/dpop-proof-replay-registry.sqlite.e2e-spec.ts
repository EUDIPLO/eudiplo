import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import {
    dpopProofEntities,
    dpopProofReplayRegistryContract,
    migrateDpopProofTable,
} from "./dpop-proof-replay-registry.contract.js";

describe("SQLite DPoP proof replay registry", () => {
    let db: DataSource;

    beforeAll(async () => {
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: dpopProofEntities,
        }).initialize();
        await migrateDpopProofTable(db);
    });

    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });

    dpopProofReplayRegistryContract(() => db);
});
