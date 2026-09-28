import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { DpopProofJtiEntity } from "../issuer/issuance/oid4vci/entities/dpop-proof-jti.entity.js";
import { BaselineMigration1740000000000 } from "./migrations/1740000000000-BaselineMigration.js";
import { AddDpopProofJti1783000000000 } from "./migrations/1783000000000-AddDpopProofJti.js";

describe("AddDpopProofJti1783000000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    test("creates the table with a composite key idempotently on SQLite", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        const migration = new AddDpopProofJti1783000000000();

        await migration.up(queryRunner);
        await migration.up(queryRunner);

        const table = await queryRunner.getTable("dpop_proof_jti");
        expect(table?.primaryColumns.map((column) => column.name)).toEqual([
            "jkt",
            "jti",
        ]);
        expect(
            table?.indices.map((index) => [index.name, index.columnNames]),
        ).toEqual([["IDX_dpop_proof_jti_expires_at", ["expiresAt"]]]);

        await migration.down(queryRunner);
        expect(await queryRunner.hasTable("dpop_proof_jti")).toBe(false);
        await queryRunner.release();
    });

    test("a fresh database bootstrapped through migrations has the table", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [DpopProofJtiEntity],
            migrations: [
                BaselineMigration1740000000000,
                AddDpopProofJti1783000000000,
            ],
            migrationsTableName: "typeorm_migrations",
            synchronize: false,
        });
        await dataSource.initialize();

        await dataSource.runMigrations();

        await expect(
            dataSource.query("SELECT * FROM dpop_proof_jti"),
        ).resolves.toEqual([]);
        // Entity metadata and migration agree: nothing left to synchronize.
        const pending = await dataSource.driver.createSchemaBuilder().log();
        expect(pending.upQueries).toEqual([]);
    });

    test("the migrated schema matches the entity", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [DpopProofJtiEntity],
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        await new AddDpopProofJti1783000000000().up(queryRunner);
        await queryRunner.release();

        const pending = await dataSource.driver.createSchemaBuilder().log();
        expect(pending.upQueries).toEqual([]);
    });
});
