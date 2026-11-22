import {
    type MigrationInterface,
    type QueryRunner,
    TableColumn,
} from "typeorm";

/**
 * Revocation of credentials together with their wallet instance (TS3 1.5
 * section 2.4.3):
 *
 * - `session.walletInstanceStatus`: the status list entry and `x5c` of the
 *   wallet attestation the token endpoint accepted (nullable).
 * - `credential_wallet_unit.attestationKind`: part of the primary key, so
 *   that a credential's status entry has a record for its key attestation
 *   (`key`) and one for its wallet attestation (`wallet`). Existing records
 *   follow key attestations and become `key`.
 */
export class AddWalletInstanceRevocation1786800000000
    implements MigrationInterface
{
    name = "AddWalletInstanceRevocation1786800000000";

    private readonly table = "credential_wallet_unit";

    async up(queryRunner: QueryRunner): Promise<void> {
        const session = await queryRunner.getTable("session");
        if (session && !session.findColumnByName("walletInstanceStatus")) {
            await queryRunner.addColumn(
                "session",
                new TableColumn({
                    name: "walletInstanceStatus",
                    type: "json",
                    isNullable: true,
                }),
            );
            console.log(
                "[Migration] Added walletInstanceStatus column to session.",
            );
        }

        // Fresh install: synchronize creates the table with the column.
        const records = await queryRunner.getTable(this.table);
        if (records && !records.findColumnByName("attestationKind")) {
            // TypeORM recreates the primary key with the new column on
            // PostgreSQL and rebuilds the table on SQLite; the default
            // fills the column of the existing rows.
            await queryRunner.addColumn(
                this.table,
                new TableColumn({
                    name: "attestationKind",
                    type: "varchar",
                    isPrimary: true,
                    isNullable: false,
                    default: "'key'",
                }),
            );
            console.log(
                `[Migration] Added attestationKind to the primary key of ${this.table}.`,
            );
        }
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        const records = await queryRunner.getTable(this.table);
        if (records?.findColumnByName("attestationKind")) {
            // Without the column, only the key attestation records fit the
            // old primary key.
            await queryRunner.manager
                .createQueryBuilder()
                .delete()
                .from(this.table)
                .where(`"attestationKind" <> :kind`, { kind: "key" })
                .execute();
            await queryRunner.dropColumn(this.table, "attestationKind");
        }
        const session = await queryRunner.getTable("session");
        if (session?.findColumnByName("walletInstanceStatus")) {
            await queryRunner.dropColumn("session", "walletInstanceStatus");
        }
    }
}
