import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

const TABLE = "issuance_config";
const COLUMN = "signingKeyId";

/**
 * Drop `issuance_config.signingKeyId`. It only selected the key chain for
 * the access tokens of the built-in authorization server. Only key chains
 * with usage type `accessToken` sign them now, and no stored value can name
 * one, so the value is dropped: the built-in authorization server uses the
 * tenant's access token key chain, or `token.signingKeyId` of its entry.
 */
export class DropIssuanceSigningKeyId1785900000000
    implements MigrationInterface
{
    name = "DropIssuanceSigningKeyId1785900000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table?.findColumnByName(COLUMN)) return;
        const rows: Array<{ tenantId: string; value: string }> =
            await queryRunner.query(
                `SELECT "tenantId", "${COLUMN}" AS "value" FROM "${TABLE}" WHERE "${COLUMN}" IS NOT NULL`,
            );
        for (const row of rows) {
            console.log(
                `[Migration] Dropped signingKeyId ${JSON.stringify(row.value)} of the issuance configuration of tenant ${row.tenantId}; its built-in authorization server now signs access tokens with the tenant's access token key chain.`,
            );
        }
        await queryRunner.dropColumn(TABLE, COLUMN);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({
                name: COLUMN,
                type: "varchar",
                isNullable: true,
            }),
        );
    }
}
