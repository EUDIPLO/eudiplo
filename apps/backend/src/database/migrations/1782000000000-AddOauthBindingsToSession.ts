import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Add OAuth binding columns to `session` required by FAPI 2.0 for the
 * built-in authorization server:
 *
 * - `request_uri_expires_at`: lifetime / single-use of PAR request_uri values
 * - `authorization_code_expires_at`: short-lived authorization codes
 * - `dpop_jkt`: DPoP key binding across PAR, token and refresh requests
 * - `client_key_jkt`: refresh token binding to the attested client instance key
 */
export class AddOauthBindingsToSession1782000000000
    implements MigrationInterface
{
    name = "AddOauthBindingsToSession1782000000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("session");
        if (!table) {
            console.log("[Migration] session table not found — skipping.");
            return;
        }

        // Match the entity's plain `Date` columns (`timestamp` on Postgres).
        const isPostgres = queryRunner.dataSource.options.type === "postgres";
        const timestampType = isPostgres ? "timestamp" : "datetime";

        const columns: TableColumn[] = [
            new TableColumn({
                name: "request_uri_expires_at",
                type: timestampType,
                isNullable: true,
            }),
            new TableColumn({
                name: "authorization_code_expires_at",
                type: timestampType,
                isNullable: true,
            }),
            new TableColumn({
                name: "dpop_jkt",
                type: "varchar",
                isNullable: true,
            }),
            new TableColumn({
                name: "client_key_jkt",
                type: "varchar",
                isNullable: true,
            }),
        ];

        for (const column of columns) {
            if (!table.columns.some((c) => c.name === column.name)) {
                await queryRunner.addColumn("session", column);
                console.log(
                    `[Migration] Added ${column.name} column to session.`,
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("session");
        if (!table) return;

        for (const name of [
            "client_key_jkt",
            "dpop_jkt",
            "authorization_code_expires_at",
            "request_uri_expires_at",
        ]) {
            if (table.columns.some((c) => c.name === name)) {
                await queryRunner.dropColumn("session", name);
            }
        }
    }
}
