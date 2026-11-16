import {
    type MigrationInterface,
    type QueryRunner,
    Table,
    TableForeignKey,
} from "typeorm";

/**
 * Adds `trust_list_fetch_status`: how the last load of each trust list
 * ended per tenant, so operators can see lists that fail or lapse. Additive;
 * the table fills as lists are loaded.
 */
export class AddTrustListFetchStatus1786400000000
    implements MigrationInterface
{
    name = "AddTrustListFetchStatus1786400000000";

    private readonly table = "trust_list_fetch_status";

    async up(queryRunner: QueryRunner): Promise<void> {
        // Fresh install: synchronize creates the schema.
        if (
            !(await queryRunner.hasTable("tenant_entity")) ||
            (await queryRunner.hasTable(this.table))
        ) {
            return;
        }
        await queryRunner.createTable(
            new Table({
                name: this.table,
                columns: [
                    { name: "tenantId", type: "varchar", isPrimary: true },
                    { name: "url", type: "varchar", isPrimary: true },
                    { name: "trustListId", type: "varchar", isNullable: true },
                    { name: "outcome", type: "varchar" },
                    { name: "reason", type: "varchar", isNullable: true },
                    // Epoch milliseconds, like the entity's transformer.
                    { name: "checkedAt", type: "bigint" },
                    { name: "verifiedAt", type: "bigint", isNullable: true },
                    { name: "acceptedAt", type: "bigint", isNullable: true },
                    { name: "nextUpdate", type: "varchar", isNullable: true },
                    {
                        name: "sequenceNumber",
                        type: "bigint",
                        isNullable: true,
                    },
                    { name: "entities", type: "integer", isNullable: true },
                ],
                foreignKeys: [
                    new TableForeignKey({
                        columnNames: ["tenantId"],
                        referencedTableName: "tenant_entity",
                        referencedColumnNames: ["id"],
                        onDelete: "CASCADE",
                    }),
                ],
            }),
            true,
        );
        console.log(`[Migration] Created ${this.table} table.`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable(this.table)) {
            await queryRunner.dropTable(this.table);
        }
    }
}
