import { createHash } from "node:crypto";
import { MigrationInterface, QueryRunner } from "typeorm";

/** Columns that held authorization or pre-authorized codes, by table. */
const CODE_COLUMNS: [table: string, column: string][] = [
    ["session", "authorization_code"],
    ["chained_as_session", "authorizationCode"],
    ["interactive_auth_session", "authorizationCode"],
];

/**
 * Replace stored authorization codes and pre-authorized codes by their
 * base64url SHA-256 hash (`hashAuthorizationCode`), so that the database no
 * longer holds redeemable codes. The token endpoint looks codes up by hash,
 * so offers and authorizations created before the migration keep working.
 *
 * A hash cannot be turned back into the code: after a revert, the affected
 * codes are rejected and wallets start the issuance again.
 */
export class HashAuthorizationCodes1784700000000 implements MigrationInterface {
    name = "HashAuthorizationCodes1784700000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const postgres = queryRunner.connection.options.type === "postgres";
        const { driver } = queryRunner.connection;
        for (const [tableName, column] of CODE_COLUMNS) {
            const table = await queryRunner.getTable(tableName);
            if (!table?.findColumnByName(column)) continue;

            const tablePath = this.tablePath(queryRunner, table.name);
            const name = driver.escape(column);
            const rows: { id: string; code: string }[] =
                await queryRunner.query(
                    `SELECT "id", ${name} AS "code" FROM ${tablePath} WHERE ${name} IS NOT NULL`,
                );
            for (const { id, code } of rows) {
                await queryRunner.query(
                    `UPDATE ${tablePath} SET ${name} = ${postgres ? "$1" : "?"} WHERE "id" = ${postgres ? "$2" : "?"}`,
                    [createHash("sha256").update(code).digest("base64url"), id],
                );
            }
            if (rows.length > 0) {
                console.log(
                    `[Migration] Hashed ${rows.length} code(s) in ${tableName}.${column}.`,
                );
            }
        }
    }

    public async down(): Promise<void> {
        // Hashes cannot be turned back into codes.
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
