import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { AddTenantActionLog1762000000000 } from "./migrations/1762000000000-AddTenantActionLog.js";
import { AddAuditLogTenantTimestampIndex1786600000000 } from "./migrations/1786600000000-AddAuditLogTenantTimestampIndex.js";

describe("AddAuditLogTenantTimestampIndex1786600000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    test("adds the index idempotently and removes it again", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        await new AddTenantActionLog1762000000000().up(queryRunner);
        const migration = new AddAuditLogTenantTimestampIndex1786600000000();

        await migration.up(queryRunner);
        await migration.up(queryRunner);

        const indexOf = async () =>
            (await queryRunner.getTable("tenant_action_log"))?.indices.find(
                (index) =>
                    index.name === "IDX_tenant_action_log_tenant_timestamp",
            );
        expect((await indexOf())?.columnNames).toEqual([
            "tenantId",
            "timestamp",
        ]);

        await migration.down(queryRunner);
        expect(await indexOf()).toBeUndefined();
        await queryRunner.release();
    });

    test("skips a database without the audit log table", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        await expect(
            new AddAuditLogTenantTimestampIndex1786600000000().up(queryRunner),
        ).resolves.toBeUndefined();
        await queryRunner.release();
    });
});
