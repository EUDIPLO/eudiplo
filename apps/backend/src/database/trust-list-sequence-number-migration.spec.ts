import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../auth/client/entities/client.entity.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { TrustListSequenceNumberEntity } from "../trust/entities/trust-list-sequence-number.entity.js";
import { AddTrustListSequenceNumber1786100000000 } from "./migrations/1786100000000-AddTrustListSequenceNumber.js";

describe("AddTrustListSequenceNumber1786100000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    async function migrated() {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                TenantEntity,
                ClientEntity,
                TrustListSequenceNumberEntity,
            ],
        });
        await dataSource.initialize();
        // Every other table as synchronize creates it; only the new table
        // comes from the migration.
        await dataSource.synchronize();
        const queryRunner = dataSource.createQueryRunner();
        const migration = new AddTrustListSequenceNumber1786100000000();
        await queryRunner.dropTable("trust_list_sequence_number");
        await migration.up(queryRunner);
        await migration.up(queryRunner);
        return { queryRunner, migration };
    }

    test("creates the table keyed by tenant and URL idempotently", async () => {
        const { queryRunner, migration } = await migrated();
        const table = await queryRunner.getTable("trust_list_sequence_number");
        expect(table?.primaryColumns.map((column) => column.name)).toEqual([
            "tenantId",
            "url",
        ]);

        await migration.down(queryRunner);
        expect(await queryRunner.hasTable("trust_list_sequence_number")).toBe(
            false,
        );
        await queryRunner.release();
    });

    test("the migrated table matches the entity", async () => {
        const { queryRunner } = await migrated();
        await queryRunner.release();
        const pending = await dataSource!.driver.createSchemaBuilder().log();
        expect(pending.upQueries).toEqual([]);
    });
});
