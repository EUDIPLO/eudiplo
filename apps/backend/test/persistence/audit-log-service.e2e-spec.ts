import {
    PostgreSqlContainer,
    type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import { afterAll, beforeAll } from "vitest";
import { AuditLogEntity } from "../../src/audit-log/entities/audit-log.entity.js";
import { describeWithContainers } from "../container-runtime.js";
import { auditLogServiceContract } from "./audit-log-service.contract.js";

describeWithContainers("AuditLogService on PostgreSQL", () => {
    let db: DataSource;
    let container: StartedPostgreSqlContainer;
    beforeAll(async () => {
        container = await new PostgreSqlContainer("postgres:16-alpine").start();
        db = await new DataSource({
            type: "postgres",
            url: container.getConnectionUri(),
            entities: [AuditLogEntity],
            synchronize: true,
        }).initialize();
    }, 60_000);
    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
        await container?.stop();
    });
    auditLogServiceContract(() => db);
});
