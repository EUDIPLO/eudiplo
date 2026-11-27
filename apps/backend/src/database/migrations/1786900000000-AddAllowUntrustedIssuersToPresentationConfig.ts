import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Add the `allowUntrustedIssuers` column to `presentation_config`.
 *
 * It replaces the `SKIP_TRUST_AUTHORITY` environment variable: a presentation
 * configuration accepts DCQL credential queries without
 * `trusted_authorities` only when it opts in itself. Existing rows get
 * `false`, so they keep requiring a trusted authority per query.
 */
export class AddAllowUntrustedIssuersToPresentationConfig1786900000000
    implements MigrationInterface
{
    name = "AddAllowUntrustedIssuersToPresentationConfig1786900000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("presentation_config");
        if (!table) {
            console.log(
                "[Migration] presentation_config table not found — skipping.",
            );
            return;
        }

        if (!table.columns.some((c) => c.name === "allowUntrustedIssuers")) {
            await queryRunner.addColumn(
                "presentation_config",
                new TableColumn({
                    name: "allowUntrustedIssuers",
                    type: "boolean",
                    isNullable: false,
                    default: false,
                }),
            );
            console.log(
                "[Migration] Added allowUntrustedIssuers column to presentation_config.",
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("presentation_config");
        if (!table) return;

        if (table.columns.some((c) => c.name === "allowUntrustedIssuers")) {
            await queryRunner.dropColumn(
                "presentation_config",
                "allowUntrustedIssuers",
            );
        }
    }
}
