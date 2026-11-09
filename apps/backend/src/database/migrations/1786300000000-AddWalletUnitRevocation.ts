import {
    type MigrationInterface,
    type QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from "typeorm";

/**
 * Revocation of credentials together with their wallet unit:
 *
 * - `credential_config.revokeWithWalletUnit`: whether a configuration's
 *   credentials follow the status of the wallet unit attestation they were
 *   bound to (default false).
 * - `deferred_transaction_entity.walletUnit`: the wallet unit attestation of
 *   a deferred request, until the credential is issued.
 * - `credential_wallet_unit`: the wallet unit attestation per status entry
 *   of an issued credential, read by the background check.
 *
 * All additions are additive; existing configurations and credentials are
 * unaffected.
 */
export class AddWalletUnitRevocation1786300000000
    implements MigrationInterface
{
    name = "AddWalletUnitRevocation1786300000000";

    private readonly table = "credential_wallet_unit";
    private readonly index = "IDX_credential_wallet_unit_status";

    async up(queryRunner: QueryRunner): Promise<void> {
        const credentialConfig =
            await queryRunner.getTable("credential_config");
        if (
            credentialConfig &&
            !credentialConfig.findColumnByName("revokeWithWalletUnit")
        ) {
            await queryRunner.addColumn(
                "credential_config",
                new TableColumn({
                    name: "revokeWithWalletUnit",
                    type: "boolean",
                    isNullable: false,
                    // SQLite stores booleans as 0 and 1; synchronize writes
                    // the default as 0 there.
                    default:
                        queryRunner.connection.options.type === "postgres"
                            ? false
                            : 0,
                }),
            );
            console.log(
                "[Migration] Added revokeWithWalletUnit column to credential_config.",
            );
        }

        const deferred = await queryRunner.getTable(
            "deferred_transaction_entity",
        );
        if (deferred && !deferred.findColumnByName("walletUnit")) {
            await queryRunner.addColumn(
                "deferred_transaction_entity",
                new TableColumn({
                    name: "walletUnit",
                    type: "json",
                    isNullable: true,
                }),
            );
            console.log(
                "[Migration] Added walletUnit column to deferred_transaction_entity.",
            );
        }

        // Fresh install: the referenced tables do not exist yet, and
        // synchronize creates the schema.
        if (
            !(await queryRunner.hasTable("tenant_entity")) ||
            !(await queryRunner.hasTable("status_list_entity")) ||
            (await queryRunner.hasTable(this.table))
        ) {
            return;
        }
        await queryRunner.createTable(
            new Table({
                name: this.table,
                columns: [
                    { name: "tenantId", type: "varchar", isPrimary: true },
                    { name: "statusListId", type: "varchar", isPrimary: true },
                    { name: "index", type: "integer", isPrimary: true },
                    { name: "sessionId", type: "varchar" },
                    { name: "credentialConfigurationId", type: "varchar" },
                    { name: "walletUnitStatusUri", type: "varchar" },
                    { name: "walletUnitStatusIdx", type: "integer" },
                    { name: "walletUnitCertificates", type: "json" },
                    {
                        name: "credentialExpiresAt",
                        // Epoch milliseconds, like the entity's transformer.
                        type: "bigint",
                        isNullable: true,
                    },
                ],
                foreignKeys: [
                    new TableForeignKey({
                        columnNames: ["tenantId"],
                        referencedTableName: "tenant_entity",
                        referencedColumnNames: ["id"],
                        onDelete: "CASCADE",
                    }),
                    new TableForeignKey({
                        columnNames: ["statusListId", "tenantId"],
                        referencedTableName: "status_list_entity",
                        referencedColumnNames: ["id", "tenantId"],
                        onDelete: "CASCADE",
                    }),
                ],
                indices: [
                    new TableIndex({
                        name: this.index,
                        columnNames: ["tenantId", "walletUnitStatusUri"],
                    }),
                ],
            }),
            true,
        );
        console.log(`[Migration] Created ${this.table} table.`);
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable(this.table)) {
            await queryRunner.dropTable(this.table);
        }
        const deferred = await queryRunner.getTable(
            "deferred_transaction_entity",
        );
        if (deferred?.findColumnByName("walletUnit")) {
            await queryRunner.dropColumn(
                "deferred_transaction_entity",
                "walletUnit",
            );
        }
        const credentialConfig =
            await queryRunner.getTable("credential_config");
        if (credentialConfig?.findColumnByName("revokeWithWalletUnit")) {
            await queryRunner.dropColumn(
                "credential_config",
                "revokeWithWalletUnit",
            );
        }
    }
}
