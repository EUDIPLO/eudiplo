import { DataSource, type QueryRunner } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { AllowDeferredTransactionWithoutHolderKey1786700000000 } from "./migrations/1786700000000-AllowDeferredTransactionWithoutHolderKey.js";

const CREATE_TABLE = `CREATE TABLE "deferred_transaction_entity" (
    "transactionId" varchar PRIMARY KEY NOT NULL,
    "tenantId" varchar NOT NULL,
    "holderCnf" json NOT NULL
)`;

describe("AllowDeferredTransactionWithoutHolderKey1786700000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    async function queryRunnerWithTable() {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.query(CREATE_TABLE);
        await queryRunner.query(
            `INSERT INTO "deferred_transaction_entity" VALUES ('bound', 't', '{"kty":"EC"}')`,
        );
        return queryRunner;
    }

    const holderCnf = async (queryRunner: QueryRunner) =>
        (
            await queryRunner.getTable("deferred_transaction_entity")
        )?.findColumnByName("holderCnf");

    test("allows null idempotently and keeps the stored keys", async () => {
        const queryRunner = await queryRunnerWithTable();
        const migration =
            new AllowDeferredTransactionWithoutHolderKey1786700000000();

        await migration.up(queryRunner);
        await migration.up(queryRunner);

        expect((await holderCnf(queryRunner))?.isNullable).toBe(true);
        await queryRunner.query(
            `INSERT INTO "deferred_transaction_entity" VALUES ('unbound', 't', NULL)`,
        );
        expect(
            await queryRunner.query(
                `SELECT "transactionId", "holderCnf" FROM "deferred_transaction_entity" ORDER BY "transactionId"`,
            ),
        ).toEqual([
            { transactionId: "bound", holderCnf: '{"kty":"EC"}' },
            { transactionId: "unbound", holderCnf: null },
        ]);
        await queryRunner.release();
    });

    test("down removes transactions without a holder key and restores NOT NULL", async () => {
        const queryRunner = await queryRunnerWithTable();
        const migration =
            new AllowDeferredTransactionWithoutHolderKey1786700000000();
        await migration.up(queryRunner);
        await queryRunner.query(
            `INSERT INTO "deferred_transaction_entity" VALUES ('unbound', 't', NULL)`,
        );

        await migration.down(queryRunner);

        expect((await holderCnf(queryRunner))?.isNullable).toBe(false);
        expect(
            await queryRunner.query(
                `SELECT "transactionId" FROM "deferred_transaction_entity"`,
            ),
        ).toEqual([{ transactionId: "bound" }]);
        await queryRunner.release();
    });

    test("skips a database without the table", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        await expect(
            new AllowDeferredTransactionWithoutHolderKey1786700000000().up(
                queryRunner,
            ),
        ).resolves.toBeUndefined();
        await queryRunner.release();
    });
});
