import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

const TABLE = "tenant_entity";
const LEGACY = "defaultAccessKeyChainId";
const MAP = "defaultKeyChains";

/**
 * Replace `tenant_entity.defaultAccessKeyChainId` with the JSON column
 * `defaultKeyChains`, which holds the tenant's default key chain per usage
 * type, so further usage types need no new column. A stored default access
 * key chain moves to `{ "access": <id> }`.
 */
export class MoveDefaultAccessKeyChainIntoDefaultKeyChains1785800000000
    implements MigrationInterface
{
    name = "MoveDefaultAccessKeyChainIntoDefaultKeyChains1785800000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) {
            console.log(`[Migration] ${TABLE} table not found — skipping.`);
            return;
        }
        if (!table.findColumnByName(MAP)) {
            await queryRunner.addColumn(
                TABLE,
                new TableColumn({ name: MAP, type: "json", isNullable: true }),
            );
        }
        if (!table.findColumnByName(LEGACY)) return;

        const rows: Array<{ id: string; legacy: string }> =
            await queryRunner.query(
                `SELECT "id", "${LEGACY}" AS "legacy" FROM "${TABLE}" WHERE "${LEGACY}" IS NOT NULL`,
            );
        const [value, id] = placeholders(queryRunner);
        for (const row of rows) {
            await queryRunner.query(
                `UPDATE "${TABLE}" SET "${MAP}" = ${value} WHERE "id" = ${id}`,
                [JSON.stringify({ access: row.legacy }), row.id],
            );
        }
        await queryRunner.dropColumn(TABLE, LEGACY);
        console.log(
            `[Migration] Moved ${rows.length} default access key chain(s) into ${TABLE}.${MAP}.`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table?.findColumnByName(MAP)) return;
        if (!table.findColumnByName(LEGACY)) {
            await queryRunner.addColumn(
                TABLE,
                new TableColumn({
                    name: LEGACY,
                    type: "varchar",
                    isNullable: true,
                }),
            );
        }
        const rows: Array<{ id: string; map: unknown }> =
            await queryRunner.query(
                `SELECT "id", "${MAP}" AS "map" FROM "${TABLE}" WHERE "${MAP}" IS NOT NULL`,
            );
        const [value, id] = placeholders(queryRunner);
        for (const row of rows) {
            // SQLite returns the JSON text, PostgreSQL the parsed value.
            const map = (
                typeof row.map === "string" ? JSON.parse(row.map) : row.map
            ) as { access?: unknown } | null;
            if (typeof map?.access !== "string") continue;
            await queryRunner.query(
                `UPDATE "${TABLE}" SET "${LEGACY}" = ${value} WHERE "id" = ${id}`,
                [map.access, row.id],
            );
        }
        await queryRunner.dropColumn(TABLE, MAP);
    }
}

/** Parameter placeholders of the connection's driver, in order. */
function placeholders(queryRunner: QueryRunner): [string, string] {
    return queryRunner.connection.options.type === "postgres"
        ? ["$1", "$2"]
        : ["?", "?"];
}
