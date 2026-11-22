import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../auth/client/entities/client.entity.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../crypto/key/entities/key-chain.entity.js";
import { CredentialWalletUnit } from "../issuer/status-list/entities/credential-wallet-unit.entity.js";
import { StatusListEntity } from "../issuer/status-list/entities/status-list.entity.js";
import { Session } from "../session/entities/session.entity.js";
import { AddWalletInstanceRevocation1786800000000 } from "./migrations/1786800000000-AddWalletInstanceRevocation.js";

describe("AddWalletInstanceRevocation1786800000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    async function schemaBefore() {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                TenantEntity,
                ClientEntity,
                KeyChainEntity,
                StatusListEntity,
                CredentialWalletUnit,
                Session,
            ],
        });
        await dataSource.initialize();
        await dataSource.synchronize();
        const queryRunner = dataSource.createQueryRunner();
        const migration = new AddWalletInstanceRevocation1786800000000();
        // The schema of 10.x, with a record written then.
        await migration.down(queryRunner);
        // The record alone; its tenant and status list do not matter here.
        await queryRunner.query("PRAGMA foreign_keys = OFF");
        await queryRunner.query(
            `INSERT INTO "credential_wallet_unit" ("tenantId", "statusListId", "index", "sessionId", "credentialConfigurationId", "walletUnitStatusUri", "walletUnitStatusIdx", "walletUnitCertificates") VALUES ('t', 'l', 4, 's', 'pid', 'https://wp.example/ka', 7, '["leaf"]')`,
        );
        return { queryRunner, migration };
    }

    test("keeps existing records as key attestation records and adds the columns idempotently", async () => {
        const { queryRunner, migration } = await schemaBefore();
        await migration.up(queryRunner);
        await migration.up(queryRunner);

        const table = await queryRunner.getTable("credential_wallet_unit");
        expect(table?.primaryColumns.map((column) => column.name)).toEqual([
            "tenantId",
            "statusListId",
            "index",
            "attestationKind",
        ]);
        expect(
            (await queryRunner.getTable("session"))?.findColumnByName(
                "walletInstanceStatus",
            ),
        ).toBeDefined();
        const records = dataSource!.getRepository(CredentialWalletUnit);
        expect(await records.find()).toEqual([
            expect.objectContaining({
                index: 4,
                attestationKind: "key",
                walletUnitStatusIdx: 7,
            }),
        ]);

        // A wallet attestation record for the same entry fits next to it.
        await records.insert({
            tenantId: "t",
            statusListId: "l",
            index: 4,
            attestationKind: "wallet",
            sessionId: "s",
            credentialConfigurationId: "pid",
            walletUnitStatusUri: "https://wp.example/wia",
            walletUnitStatusIdx: 1337,
            walletUnitCertificates: ["leaf"],
        });
        expect(await records.count()).toBe(2);

        await migration.down(queryRunner);
        expect(
            (
                await queryRunner.getTable("credential_wallet_unit")
            )?.findColumnByName("attestationKind"),
        ).toBeUndefined();
        expect(
            await queryRunner.query(`SELECT * FROM "credential_wallet_unit"`),
        ).toHaveLength(1);
        await queryRunner.release();
    });

    test("the migrated credential_wallet_unit table matches the entity", async () => {
        const { queryRunner, migration } = await schemaBefore();
        await migration.up(queryRunner);
        await queryRunner.release();
        const pending = await dataSource!.driver.createSchemaBuilder().log();
        // The session table is rebuilt by the SQLite schema builder even
        // right after synchronize, so only this table is compared.
        expect(
            pending.upQueries
                .map((query) => query.query)
                .filter((query) => query.includes("credential_wallet_unit")),
        ).toEqual([]);
    });
});
