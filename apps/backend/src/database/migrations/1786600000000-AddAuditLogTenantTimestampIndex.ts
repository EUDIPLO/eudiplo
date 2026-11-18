import { MigrationInterface, QueryRunner, TableIndex } from "typeorm";

const TABLE = "tenant_action_log";
const INDEX = "IDX_tenant_action_log_tenant_timestamp";

/**
 * Index the audit log by tenant and time: every list and search query filters
 * on the tenant and orders by timestamp, often within a time range.
 */
export class AddAuditLogTenantTimestampIndex1786600000000
    implements MigrationInterface
{
    name = "AddAuditLogTenantTimestampIndex1786600000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) {
            console.log(`[Migration] ${TABLE} table not found — skipping.`);
            return;
        }
        if (table.indices.some((index) => index.name === INDEX)) return;
        await queryRunner.createIndex(
            TABLE,
            new TableIndex({
                name: INDEX,
                columnNames: ["tenantId", "timestamp"],
            }),
        );
        console.log(`[Migration] Added ${INDEX}.`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (table?.indices.some((index) => index.name === INDEX))
            await queryRunner.dropIndex(TABLE, INDEX);
    }
}
