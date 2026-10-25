import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Add `defaultAccessKeyChainId` to `tenant_entity`: the access key chain used
 * where no configuration names one.
 *
 * Existing tenants keep NULL and pick their access key chain by rule as
 * before.
 */
export class AddDefaultAccessKeyChainIdToTenant1785600000000
    implements MigrationInterface
{
    name = "AddDefaultAccessKeyChainIdToTenant1785600000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("tenant_entity");
        if (!table) {
            console.log(
                "[Migration] tenant_entity table not found — skipping.",
            );
            return;
        }

        if (!table.findColumnByName("defaultAccessKeyChainId")) {
            await queryRunner.addColumn(
                "tenant_entity",
                new TableColumn({
                    name: "defaultAccessKeyChainId",
                    type: "varchar",
                    isNullable: true,
                }),
            );
            console.log(
                "[Migration] Added defaultAccessKeyChainId column to tenant_entity.",
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("tenant_entity");
        if (table?.findColumnByName("defaultAccessKeyChainId")) {
            await queryRunner.dropColumn(
                "tenant_entity",
                "defaultAccessKeyChainId",
            );
        }
    }
}
