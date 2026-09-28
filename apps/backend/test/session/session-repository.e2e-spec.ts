import {
    PostgreSqlContainer,
    type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import {
    initializeTestEncryption,
    sessionEntities,
    sessionRepositoryContract,
} from "./session-repository.contract.js";

describe("PostgreSQL session repository", () => {
    let db: DataSource;
    let container: StartedPostgreSqlContainer;
    beforeAll(async () => {
        await initializeTestEncryption();
        container = await new PostgreSqlContainer("postgres:16-alpine").start();
        db = await new DataSource({
            type: "postgres",
            url: container.getConnectionUri(),
            entities: sessionEntities,
            synchronize: true,
        }).initialize();
    }, 60_000);
    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
        await container?.stop();
    });
    sessionRepositoryContract(() => db);
});
