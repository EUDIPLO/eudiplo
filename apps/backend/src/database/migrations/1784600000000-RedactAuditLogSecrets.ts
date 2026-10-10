import { MigrationInterface, QueryRunner } from "typeorm";

const REDACTED = "[REDACTED]";

/** Secret paths in the `before`/`after` snapshots, by action type. */
const SECRET_PATHS: Record<string, string> = {
    webhook_endpoint_created: "auth.config.value",
    webhook_endpoint_updated: "auth.config.value",
    webhook_endpoint_deleted: "auth.config.value",
    attribute_provider_created: "auth.config.value",
    attribute_provider_updated: "auth.config.value",
    attribute_provider_deleted: "auth.config.value",
    issuance_config_updated: "authorizationServers.*.upstream.clientSecret",
};

/**
 * Replace the string at `path` (`*` matches every key or array index) with
 * `[REDACTED]`.
 */
function redact(value: unknown, [segment, ...rest]: string[]): unknown {
    if (segment === undefined) {
        return typeof value === "string" ? REDACTED : value;
    }
    if (Array.isArray(value)) {
        return value.map((item, index) =>
            segment === "*" || segment === String(index)
                ? redact(item, rest)
                : item,
        );
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                segment === "*" || segment === key ? redact(item, rest) : item,
            ]),
        );
    }
    return value;
}

/**
 * Redact secrets that earlier versions copied into the audit log: the API
 * keys of webhook endpoints and attribute providers and the upstream client
 * secrets of chained authorization servers in the `before` and `after`
 * snapshots. New entries are redacted when they are written.
 */
export class RedactAuditLogSecrets1784600000000 implements MigrationInterface {
    name = "RedactAuditLogSecrets1784600000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("tenant_action_log");
        if (!table) return;

        const postgres = queryRunner.connection.options.type === "postgres";
        const parameter = (index: number) => (postgres ? `$${index}` : "?");
        const tablePath = this.tablePath(queryRunner, table.name);
        const actionTypes = Object.keys(SECRET_PATHS);

        const rows: {
            id: string;
            actionType: string;
            before: unknown;
            after: unknown;
        }[] = await queryRunner.query(
            `SELECT "id", "actionType", "before", "after" FROM ${tablePath} WHERE "actionType" IN (${actionTypes
                .map((_, index) => parameter(index + 1))
                .join(", ")})`,
            actionTypes,
        );
        let redacted = 0;
        for (const row of rows) {
            const path = SECRET_PATHS[row.actionType].split(".");
            const snapshots = (["before", "after"] as const).map((column) => {
                // node-postgres parses json columns, SQLite returns their text.
                const stored =
                    !postgres && typeof row[column] === "string"
                        ? JSON.parse(row[column])
                        : row[column];
                return { stored, next: redact(stored, path) };
            });
            if (
                snapshots.every(
                    ({ stored, next }) =>
                        JSON.stringify(stored) === JSON.stringify(next),
                )
            ) {
                continue;
            }
            await queryRunner.query(
                `UPDATE ${tablePath} SET "before" = ${parameter(1)}, "after" = ${parameter(2)} WHERE "id" = ${parameter(3)}`,
                [
                    ...snapshots.map(({ next }) =>
                        next === null || next === undefined
                            ? null
                            : JSON.stringify(next),
                    ),
                    row.id,
                ],
            );
            redacted++;
        }
        if (redacted > 0) {
            console.log(
                `[Migration] Redacted secrets in ${redacted} audit log entries.`,
            );
        }
    }

    public async down(): Promise<void> {
        // Redacted secrets cannot be restored.
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
