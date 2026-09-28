import {
    PostgreSqlContainer,
    type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import { afterAll, beforeAll } from "vitest";
import { describeWithContainers } from "../container-runtime.js";
import {
    dpopProofEntities,
    dpopProofReplayRegistryContract,
    migrateDpopProofTable,
} from "./dpop-proof-replay-registry.contract.js";

describeWithContainers("PostgreSQL DPoP proof replay registry", () => {
    let db: DataSource;
    let container: StartedPostgreSqlContainer;

    beforeAll(async () => {
        container = await new PostgreSqlContainer("postgres:16-alpine").start();
        db = await new DataSource({
            type: "postgres",
            url: container.getConnectionUri(),
            entities: dpopProofEntities,
            // Several connections, so concurrent registrations really race.
            extra: { max: 8 },
        }).initialize();
        await migrateDpopProofTable(db);
    }, 60_000);

    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
        await container?.stop();
    });

    dpopProofReplayRegistryContract(() => db);
});
