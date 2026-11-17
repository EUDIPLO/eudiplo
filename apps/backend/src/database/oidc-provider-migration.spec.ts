import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../auth/client/entities/client.entity.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { OidcClientEntity } from "../verifier/oidc-provider/entities/oidc-client.entity.js";
import { OidcSignInEntity } from "../verifier/oidc-provider/entities/oidc-sign-in.entity.js";
import { AddOidcProvider1786400000000 } from "./migrations/1786400000000-AddOidcProvider.js";

describe("AddOidcProvider1786400000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    test("creates both tables idempotently and removes them again", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [TenantEntity, ClientEntity],
        });
        await dataSource.initialize();
        await dataSource.synchronize();
        const queryRunner = dataSource.createQueryRunner();
        const migration = new AddOidcProvider1786400000000();

        await migration.up(queryRunner);
        await migration.up(queryRunner);

        const clients = await queryRunner.getTable("oidc_client");
        expect(clients?.primaryColumns.map((column) => column.name)).toEqual([
            "id",
            "tenantId",
        ]);
        const signIns = await queryRunner.getTable("oidc_sign_in");
        expect(signIns?.findColumnByName("browserBindingHash")).toBeDefined();
        expect(signIns?.indices.map((index) => index.name)).toEqual(
            expect.arrayContaining([
                "IDX_oidc_sign_in_code",
                "IDX_oidc_sign_in_expires",
            ]),
        );
        expect(signIns?.foreignKeys).toHaveLength(1);

        await migration.down(queryRunner);
        expect(await queryRunner.hasTable("oidc_client")).toBe(false);
        expect(await queryRunner.hasTable("oidc_sign_in")).toBe(false);
        await queryRunner.release();
    });

    test("matches the schema the entities produce", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                TenantEntity,
                ClientEntity,
                OidcClientEntity,
                OidcSignInEntity,
            ],
        });
        await dataSource.initialize();
        await dataSource.synchronize();
        const drift = async () =>
            (await dataSource!.driver.createSchemaBuilder().log()).upQueries
                .map((query) => query.query)
                .sort();
        const driftAfterSynchronize = await drift();
        const queryRunner = dataSource.createQueryRunner();
        const migration = new AddOidcProvider1786400000000();
        await migration.down(queryRunner);
        await migration.up(queryRunner);
        expect(await drift()).toEqual(driftAfterSynchronize);
        await queryRunner.release();
    });

    test("does nothing on a fresh install", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        await new AddOidcProvider1786400000000().up(queryRunner);
        expect(await queryRunner.hasTable("oidc_client")).toBe(false);
        await queryRunner.release();
    });
});
