import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddStatusUpdatedAtToStatusMapping1785600000000
    implements MigrationInterface
{
    name = "AddStatusUpdatedAtToStatusMapping1785600000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("status_mapping");
        if (!table) {
            console.log(
                "[Migration] status_mapping table not found — skipping.",
            );
            return;
        }

        if (!table.findColumnByName("statusUpdatedAt")) {
            await queryRunner.addColumn(
                "status_mapping",
                new TableColumn({
                    name: "statusUpdatedAt",
                    type:
                        queryRunner.connection.options.type === "postgres"
                            ? "timestamp"
                            : "datetime",
                    isNullable: true,
                }),
            );
            console.log(
                "[Migration] Added statusUpdatedAt column to status_mapping.",
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("status_mapping");
        if (table?.findColumnByName("statusUpdatedAt")) {
            await queryRunner.dropColumn("status_mapping", "statusUpdatedAt");
        }
    }
}
