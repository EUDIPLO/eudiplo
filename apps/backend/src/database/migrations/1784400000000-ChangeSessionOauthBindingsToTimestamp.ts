import { MigrationInterface, QueryRunner } from "typeorm";

const COLUMNS = ["request_uri_expires_at", "authorization_code_expires_at"];

/**
 * Store `session.request_uri_expires_at` and
 * `session.authorization_code_expires_at` as `timestamp` on Postgres, the type
 * the entity declares.
 *
 * AddOauthBindingsToSession1782000000000 created both columns as
 * `timestamp with time zone` in development builds, so databases migrated by
 * those builds differed from fresh installations and schema synchronization
 * would drop and re-add the columns. SQLite stores both as `datetime` either
 * way.
 */
export class ChangeSessionOauthBindingsToTimestamp1784400000000
    implements MigrationInterface
{
    name = "ChangeSessionOauthBindingsToTimestamp1784400000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (queryRunner.connection.options.type !== "postgres") return;

        const table = await queryRunner.getTable("session");
        if (!table) {
            console.log("[Migration] session table not found — skipping.");
            return;
        }

        // node-postgres reads and writes `timestamp` values in the process
        // time zone, so keep the instants by converting to that zone.
        const timeZone = await this.processTimeZone(queryRunner);
        for (const name of COLUMNS) {
            if (
                table.findColumnByName(name)?.type !==
                "timestamp with time zone"
            ) {
                continue;
            }
            await queryRunner.query(
                `ALTER TABLE ${this.tablePath(queryRunner, table.name)} ALTER COLUMN "${name}" TYPE timestamp USING "${name}" AT TIME ZONE '${timeZone}'`,
            );
            console.log(`[Migration] Changed session.${name} to timestamp.`);
        }
    }

    public async down(): Promise<void> {
        // AddOauthBindingsToSession1782000000000 now creates `timestamp`
        // columns as well, so there is no earlier type to restore.
    }

    private async processTimeZone(queryRunner: QueryRunner): Promise<string> {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const [{ known }] = await queryRunner.query(
            "SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS known",
            [timeZone],
        );
        return known ? timeZone : "UTC";
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
