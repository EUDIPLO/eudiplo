import {
    PostgreSqlContainer,
    type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import { afterAll, beforeAll } from "vitest";
import { IssuanceConfig } from "../../src/issuer/configuration/issuance/entities/issuance-config.entity.js";
import { describeWithContainers } from "../container-runtime.js";
import {
    credentialEntities,
    credentialRepositoryContract,
} from "./credential-repository.contract.js";
import { endpointRepositoryContract } from "./endpoint-repository.contract.js";
import { issuanceRepositoryContract } from "./issuance-repository.contract.js";
import { tenantRepositoryContract } from "./tenant-repository.contract.js";
import { initializeTestEncryption } from "./test-encryption.js";

describeWithContainers("PostgreSQL configuration endpoint repositories", () => {
    let db: DataSource;
    let container: StartedPostgreSqlContainer;
    beforeAll(async () => {
        await initializeTestEncryption();
        container = await new PostgreSqlContainer("postgres:16-alpine").start();
        db = await new DataSource({
            type: "postgres",
            url: container.getConnectionUri(),
            entities: [...credentialEntities, IssuanceConfig],
            synchronize: true,
        }).initialize();
    }, 60_000);
    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
        await container?.stop();
    });
    credentialRepositoryContract(() => db);
    issuanceRepositoryContract(() => db);
    tenantRepositoryContract(() => db);
    endpointRepositoryContract(() => db, "attribute-provider");
    endpointRepositoryContract(() => db, "webhook-endpoint");
});
