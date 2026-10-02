import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Add `offerLifetimeSeconds` to `issuance_config`: the default time a
 * credential offer can be redeemed. Nullable; offers of existing
 * configurations keep having no lifetime.
 */
export class AddOfferLifetimeToIssuanceConfig1784100000000
    implements MigrationInterface
{
    name = "AddOfferLifetimeToIssuanceConfig1784100000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("issuance_config");
        if (!table) {
            console.log(
                "[Migration] issuance_config table not found — skipping (schema may not exist yet).",
            );
            return;
        }
        if (table.findColumnByName("offerLifetimeSeconds")) {
            console.log(
                "[Migration] offerLifetimeSeconds column already exists — skipping.",
            );
            return;
        }

        await queryRunner.addColumn(
            "issuance_config",
            new TableColumn({
                name: "offerLifetimeSeconds",
                // "integer" is what the int column of the entity reads back as.
                type: "integer",
                isNullable: true,
            }),
        );
        console.log(
            "[Migration] Added offerLifetimeSeconds column to issuance_config.",
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("issuance_config");
        if (table?.findColumnByName("offerLifetimeSeconds")) {
            await queryRunner.dropColumn(
                "issuance_config",
                "offerLifetimeSeconds",
            );
        }
    }
}
