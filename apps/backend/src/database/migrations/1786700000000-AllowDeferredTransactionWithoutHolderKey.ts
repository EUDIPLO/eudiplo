import {
    type MigrationInterface,
    type QueryRunner,
    TableColumn,
} from "typeorm";

const TABLE = "deferred_transaction_entity";
const COLUMN = "holderCnf";

/**
 * `deferred_transaction_entity.holderCnf` may be null: a credential
 * configuration that needs no key proof (an SD-JWT VC with `keyBinding` off
 * and no required key attestation) is issued without a holder key, also when
 * its issuance is deferred. Existing rows keep their key.
 */
export class AllowDeferredTransactionWithoutHolderKey1786700000000
    implements MigrationInterface
{
    name = "AllowDeferredTransactionWithoutHolderKey1786700000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        const column = table?.findColumnByName(COLUMN);
        if (!table || !column) {
            console.log(
                `[Migration] ${TABLE}.${COLUMN} not found — skipping (schema may not exist yet).`,
            );
            return;
        }
        if (column.isNullable) return;
        await queryRunner.changeColumn(
            table,
            column,
            new TableColumn({ name: COLUMN, type: "json", isNullable: true }),
        );
        console.log(`[Migration] ${TABLE}.${COLUMN} may now be null.`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        const column = table?.findColumnByName(COLUMN);
        if (!table || !column?.isNullable) return;
        // Pending transactions without a holder key cannot be kept under the
        // old constraint; their wallets get invalid_transaction_id.
        await queryRunner.query(
            `DELETE FROM ${this.tablePath(queryRunner, table.name)} WHERE "${COLUMN}" IS NULL`,
        );
        await queryRunner.changeColumn(
            table,
            column,
            new TableColumn({ name: COLUMN, type: "json", isNullable: false }),
        );
    }

    private tablePath(queryRunner: QueryRunner, name: string): string {
        const { driver } = queryRunner.connection;
        const { schema, tableName } = driver.parseTableName(name);
        return [schema, tableName]
            .filter((part): part is string => !!part)
            .map((part) => driver.escape(part))
            .join(".");
    }
}
