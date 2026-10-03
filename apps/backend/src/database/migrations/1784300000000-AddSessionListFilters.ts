import {
    MigrationInterface,
    QueryRunner,
    TableColumn,
    TableIndex,
} from "typeorm";

/** Indexes for the session list filters and the wallet nonce lookup. */
const INDEXES = [
    ["IDX_session_tenant_created_at", ["tenantId", "createdAt"]],
    ["IDX_session_tenant_updated_at", ["tenantId", "updatedAt"]],
    ["IDX_session_tenant_status", ["tenantId", "status"]],
    ["IDX_session_tenant_request_id", ["tenantId", "requestId"]],
    ["IDX_session_tenant_reference", ["tenantId", "reference"]],
    ["IDX_session_wallet_nonce", ["walletNonce"]],
] as const;

/**
 * Add the plaintext `reference` and `credentialConfigurationIds` columns to
 * `session` and index the columns the session list filters and sorts on.
 * Existing sessions keep both columns empty: their credential configuration
 * ids exist only in the encrypted payload and are not backfilled.
 */
export class AddSessionListFilters1784300000000 implements MigrationInterface {
    name = "AddSessionListFilters1784300000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("session");
        if (!table) {
            console.log("[Migration] session table not found — skipping.");
            return;
        }

        if (!table.findColumnByName("reference")) {
            await queryRunner.addColumn(
                "session",
                new TableColumn({
                    name: "reference",
                    type: "varchar",
                    isNullable: true,
                }),
            );
            console.log("[Migration] Added reference column to session.");
        }
        if (!table.findColumnByName("credentialConfigurationIds")) {
            await queryRunner.addColumn(
                "session",
                new TableColumn({
                    name: "credentialConfigurationIds",
                    type: "json",
                    isNullable: true,
                }),
            );
            console.log(
                "[Migration] Added credentialConfigurationIds column to session.",
            );
        }

        // Re-read: adding a column on SQLite recreates the table.
        const updated = await queryRunner.getTable("session");
        for (const [name, columnNames] of INDEXES) {
            if (updated?.indices.some((index) => index.name === name)) continue;
            await queryRunner.createIndex(
                "session",
                new TableIndex({ name, columnNames: [...columnNames] }),
            );
        }
        console.log("[Migration] Added session list indexes.");
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable("session");
        if (!table) return;
        for (const [name] of INDEXES) {
            if (table.indices.some((index) => index.name === name))
                await queryRunner.dropIndex("session", name);
        }
        if (table.findColumnByName("credentialConfigurationIds"))
            await queryRunner.dropColumn(
                "session",
                "credentialConfigurationIds",
            );
        if (table.findColumnByName("reference"))
            await queryRunner.dropColumn("session", "reference");
    }
}
