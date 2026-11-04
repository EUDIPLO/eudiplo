import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

const TABLE = "presentation_config";
const COLUMN = "allowedOrigins";

/**
 * Add `presentation_config.allowedOrigins`: the web origins that may request
 * the presentation over the Digital Credentials API. Existing rows stay
 * null, which accepts any `expected_origin` the caller names.
 */
export class AddAllowedOriginsToPresentationConfig1786000000000
    implements MigrationInterface
{
    name = "AddAllowedOriginsToPresentationConfig1786000000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: "json", isNullable: true }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table?.findColumnByName(COLUMN)) return;
        await queryRunner.dropColumn(TABLE, COLUMN);
    }
}
