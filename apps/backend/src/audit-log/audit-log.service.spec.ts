import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe } from "vitest";
import { auditLogServiceContract } from "../../test/persistence/audit-log-service.contract.js";
import { AuditLogEntity } from "./entities/audit-log.entity.js";

describe("AuditLogService on SQLite", () => {
    let db: DataSource;
    beforeAll(async () => {
        db = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [AuditLogEntity],
            synchronize: true,
        }).initialize();
    });
    afterAll(async () => {
        await db?.destroy();
    });
    auditLogServiceContract(() => db);
});
