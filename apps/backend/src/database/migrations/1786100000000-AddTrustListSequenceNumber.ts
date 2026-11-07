import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableForeignKey,
} from "typeorm";

/**
 * Adds `trust_list_sequence_number`: the highest `LoTESequenceNumber` a
 * tenant accepted per trust list URL. A list numbered lower is an older
 * version, possibly replayed, and is discarded. Kept in the database so the
 * check holds across restarts and for every instance.
 */
export class AddTrustListSequenceNumber1786100000000
    implements MigrationInterface
{
    name = "AddTrustListSequenceNumber1786100000000";

    async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable("trust_list_sequence_number")) {
            return;
        }
        await queryRunner.createTable(
            new Table({
                name: "trust_list_sequence_number",
                columns: [
                    { name: "tenantId", type: "varchar", isPrimary: true },
                    { name: "url", type: "varchar", isPrimary: true },
                    { name: "sequenceNumber", type: "bigint" },
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
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable("trust_list_sequence_number")) {
            await queryRunner.dropTable("trust_list_sequence_number");
        }
    }
}
