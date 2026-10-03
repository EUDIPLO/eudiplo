import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Store `session.expiresAt` as a timestamp instead of a date.
 *
 * The column was declared as `date`, so only `YYYY-MM-DD` was persisted and
 * the configured lifetime of presentation requests was lost. Existing values
 * can only be recovered as midnight of the stored day, which is also the
 * instant the maintenance job compared against before this change.
 */
export class ChangeSessionExpiresAtToTimestamp1784000000000
    implements MigrationInterface
{
    name = "ChangeSessionExpiresAtToTimestamp1784000000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("session");
        const column = table?.findColumnByName("expiresAt");
        if (!table || !column) {
            console.log(
                "[Migration] session.expiresAt not found — skipping (schema may not exist yet).",
            );
            return;
        }
        if (column.type !== "date") {
            console.log(
                "[Migration] session.expiresAt is already a timestamp — skipping.",
            );
            return;
        }

        if (queryRunner.connection.options.type === "postgres") {
            // changeColumn would drop and re-add the column on a type change.
            await queryRunner.query(
                `ALTER TABLE ${this.tablePath(queryRunner, table.name)} ALTER COLUMN "expiresAt" TYPE timestamp USING "expiresAt"::timestamp`,
            );
        } else {
            // SQLite recreates the table and copies the stored values.
            await queryRunner.changeColumn(
                table,
                column,
                new TableColumn({
                    name: "expiresAt",
                    type: "datetime",
                    isNullable: true,
                }),
            );
            // Use the format TypeORM writes for datetime columns, so string
            // comparisons against new values stay correct.
            await queryRunner.query(
                `UPDATE "session" SET "expiresAt" = "expiresAt" || ' 00:00:00.000' WHERE length("expiresAt") = 10`,
            );
        }
        console.log("[Migration] Changed session.expiresAt to a timestamp.");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("session");
        const column = table?.findColumnByName("expiresAt");
        if (!table || !column || column.type === "date") return;

        if (queryRunner.connection.options.type === "postgres") {
            await queryRunner.query(
                `ALTER TABLE ${this.tablePath(queryRunner, table.name)} ALTER COLUMN "expiresAt" TYPE date USING "expiresAt"::date`,
            );
        } else {
            await queryRunner.changeColumn(
                table,
                column,
                new TableColumn({
                    name: "expiresAt",
                    type: "date",
                    isNullable: true,
                }),
            );
            await queryRunner.query(
                `UPDATE "session" SET "expiresAt" = substr("expiresAt", 1, 10) WHERE length("expiresAt") > 10`,
            );
        }
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
