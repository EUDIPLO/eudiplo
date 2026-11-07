import {
    isTrustListEntityUri,
    trustListCountryCode,
    trustListLanguageTag,
} from "@eudiplo/config-format/trust-list-entity-info.js";
import type { MigrationInterface, QueryRunner } from "typeorm";

const TABLE = "trust_list";
const COLUMN = "entityConfig";

/**
 * Brings the stored entity info of managed trust lists to ETSI TS 119 602
 * clauses 6.1.5 and 6.1.4, as the TrustList v1 -> v2 config-file migration
 * does: `country` in capital letters ("GB"/"GR" become "UK"/"EL") and `lang`
 * in lower case. Values that cannot be fixed, and a `uri` the API now
 * refuses, stay and are logged, so the
 * operator corrects them with the next update. Exports and the Web Client edit
 * page then show values that the API accepts. The signed list keeps its
 * published values until the next update.
 */
export class NormalizeTrustListEntityInfo1786200000000
    implements MigrationInterface
{
    name = "NormalizeTrustListEntityInfo1786200000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table?.findColumnByName(COLUMN)) return;

        const escape = (identifier: string) =>
            queryRunner.connection.driver.escape(identifier);
        const param = (n: number) =>
            queryRunner.connection.options.type === "postgres" ? `$${n}` : "?";

        const rows: Array<{
            id: string;
            tenantId: string;
            entityConfig: unknown;
        }> = await queryRunner.query(
            `SELECT ${escape("id")}, ${escape("tenantId")}, ${escape(COLUMN)} FROM ${escape(TABLE)} WHERE ${escape(COLUMN)} IS NOT NULL`,
        );

        let migrated = 0;
        const unfixable: string[] = [];
        for (const row of rows) {
            const entities =
                typeof row.entityConfig === "string"
                    ? JSON.parse(row.entityConfig)
                    : row.entityConfig;
            if (!Array.isArray(entities)) continue;
            let changed = false;
            entities.forEach((entity: unknown, index: number) => {
                const info = (entity as { info?: unknown } | null)?.info;
                if (!info || typeof info !== "object") return;
                const fields = info as Record<string, unknown>;
                for (const [key, fix] of [
                    ["country", trustListCountryCode],
                    ["lang", trustListLanguageTag],
                ] as const) {
                    const value = fields[key];
                    if (value === undefined || value === null) continue;
                    const fixed = fix(value);
                    if (fixed === undefined) {
                        unfixable.push(
                            `${row.tenantId}/${row.id} entities.${index}.info.${key}`,
                        );
                    } else if (fixed !== value) {
                        fields[key] = fixed;
                        changed = true;
                    }
                }
                // A uri cannot be fixed; 9.x refused relative ones already,
                // but stored others the URL parser repairs.
                if (
                    fields.uri !== undefined &&
                    fields.uri !== null &&
                    !(
                        typeof fields.uri === "string" &&
                        isTrustListEntityUri(fields.uri)
                    )
                ) {
                    unfixable.push(
                        `${row.tenantId}/${row.id} entities.${index}.info.uri`,
                    );
                }
            });
            if (!changed) continue;
            await queryRunner.query(
                `UPDATE ${escape(TABLE)} SET ${escape(COLUMN)} = ${param(1)} WHERE ${escape("id")} = ${param(2)} AND ${escape("tenantId")} = ${param(3)}`,
                [JSON.stringify(entities), row.id, row.tenantId],
            );
            migrated++;
        }

        if (migrated > 0) {
            console.log(
                `[Migration] Fixed the case of entity country codes and language tags in ${migrated} trust list(s) (ETSI TS 119 602 clauses 6.1.4, 6.1.5).`,
            );
        }
        if (unfixable.length > 0) {
            console.warn(
                `[Migration] Trust list entity info the API now refuses, fix it with the next update: ${unfixable.join(", ")}`,
            );
        }
    }

    public async down(): Promise<void> {
        // The previous case of the values is not kept; the fixed values are
        // valid in 9.x as well.
    }
}
