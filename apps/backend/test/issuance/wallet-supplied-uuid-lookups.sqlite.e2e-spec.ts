import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import { initializeTestEncryption } from "../persistence/test-encryption.js";
import {
    walletSuppliedUuidEntities,
    walletSuppliedUuidLookupsContract,
} from "./wallet-supplied-uuid-lookups.contract.js";

describe("SQLite wallet-supplied uuid lookups", () => {
    let db: DataSource;

    beforeAll(async () => {
        await initializeTestEncryption();
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: walletSuppliedUuidEntities,
            synchronize: true,
        }).initialize();
    });

    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });

    walletSuppliedUuidLookupsContract(() => db);
});
