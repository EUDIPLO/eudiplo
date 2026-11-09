import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../auth/client/entities/client.entity.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../crypto/key/entities/key-chain.entity.js";
import { AttributeProviderEntity } from "../issuer/configuration/attribute-provider/entities/attribute-provider.entity.js";
import { CredentialConfig } from "../issuer/configuration/credentials/entities/credential.entity.js";
import { WebhookEndpointEntity } from "../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { DeferredTransactionEntity } from "../issuer/issuance/oid4vci/entities/deferred-transaction.entity.js";
import { CredentialWalletUnit } from "../issuer/status-list/entities/credential-wallet-unit.entity.js";
import { StatusListEntity } from "../issuer/status-list/entities/status-list.entity.js";
import { AddWalletUnitRevocation1786300000000 } from "./migrations/1786300000000-AddWalletUnitRevocation.js";

describe("AddWalletUnitRevocation1786300000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    async function migrated() {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                TenantEntity,
                ClientEntity,
                KeyChainEntity,
                AttributeProviderEntity,
                WebhookEndpointEntity,
                CredentialConfig,
                DeferredTransactionEntity,
                StatusListEntity,
                CredentialWalletUnit,
            ],
        });
        await dataSource.initialize();
        // Every other table as synchronize creates it; the additions come
        // from the migration.
        await dataSource.synchronize();
        const queryRunner = dataSource.createQueryRunner();
        const migration = new AddWalletUnitRevocation1786300000000();
        await migration.down(queryRunner);
        await migration.up(queryRunner);
        await migration.up(queryRunner);
        return { queryRunner, migration };
    }

    test("adds the columns and the table idempotently and removes them again", async () => {
        const { queryRunner, migration } = await migrated();
        const table = await queryRunner.getTable("credential_wallet_unit");
        expect(table?.primaryColumns.map((column) => column.name)).toEqual([
            "tenantId",
            "statusListId",
            "index",
        ]);
        expect(
            (await queryRunner.getTable("credential_config"))?.findColumnByName(
                "revokeWithWalletUnit",
            ),
        ).toBeDefined();
        expect(
            (
                await queryRunner.getTable("deferred_transaction_entity")
            )?.findColumnByName("walletUnit"),
        ).toBeDefined();

        await migration.down(queryRunner);
        expect(await queryRunner.hasTable("credential_wallet_unit")).toBe(
            false,
        );
        expect(
            (await queryRunner.getTable("credential_config"))?.findColumnByName(
                "revokeWithWalletUnit",
            ),
        ).toBeUndefined();
        await queryRunner.release();
    });

    test("the migrated schema matches the entities", async () => {
        const { queryRunner } = await migrated();
        await queryRunner.release();
        const pending = await dataSource!.driver.createSchemaBuilder().log();
        expect(pending.upQueries.map((query) => query.query)).toEqual([]);
    });
});
