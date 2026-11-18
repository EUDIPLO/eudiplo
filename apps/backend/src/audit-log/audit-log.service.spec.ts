import type { ConfigService } from "@nestjs/config";
import { DataSource, type Repository } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { auditLogServiceContract } from "../../test/persistence/audit-log-service.contract.js";
import { AuditLogService } from "./audit-log.service.js";
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

describe("AuditLogService retention", () => {
    test("reports the operator's limits, 0 where none is set", () => {
        const settings: Record<string, number> = {
            AUDIT_LOG_RETENTION_DAYS: 365,
        };
        const config = {
            get: (key: string, fallback: number) => settings[key] ?? fallback,
        } as unknown as ConfigService;
        const service = new AuditLogService(
            {} as Repository<AuditLogEntity>,
            config,
        );
        expect(service.retention()).toEqual({
            retentionDays: 365,
            maxEntriesPerTenant: 0,
        });
    });
});
