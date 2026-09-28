import {
    PostgreSqlContainer,
    StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource, EntitySchema } from "typeorm";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { BaselineMigration1740000000000 } from "../src/database/migrations/1740000000000-BaselineMigration.js";
import { describeWithContainers } from "./container-runtime.js";

const ExampleEntity = new EntitySchema({
    name: "Example",
    tableName: "example_entity",
    columns: {
        id: { type: String, primary: true },
        value: { type: String },
    },
});

describeWithContainers("PostgreSQL baseline migration", () => {
    let container: StartedPostgreSqlContainer;
    let admin: DataSource;
    let dataSource: DataSource;

    beforeAll(async () => {
        container = await new PostgreSqlContainer("postgres:alpine").start();
        admin = new DataSource({
            type: "postgres",
            url: container.getConnectionUri(),
        });
        await admin.initialize();
    }, 60_000);

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    afterAll(async () => {
        if (admin?.isInitialized) await admin.destroy();
        await container?.stop();
    });

    function createDataSource(schema: string): DataSource {
        return new DataSource({
            type: "postgres",
            url: container.getConnectionUri(),
            schema,
            entities: [ExampleEntity],
            migrations: [BaselineMigration1740000000000],
            migrationsTableName: "typeorm_migrations",
            synchronize: false,
        });
    }

    test("bootstraps a custom schema despite tables in other schemas", async () => {
        await admin.query('CREATE SCHEMA "bootstrap"');
        await admin.query("CREATE TABLE public.unrelated (id integer)");
        await admin.query("INSERT INTO public.unrelated VALUES (1)");
        dataSource = createDataSource("bootstrap");
        await dataSource.initialize();

        await dataSource.runMigrations();

        await expect(
            dataSource.getRepository(ExampleEntity).find(),
        ).resolves.toEqual([]);
        await expect(
            dataSource.query('SELECT * FROM "bootstrap"."typeorm_migrations"'),
        ).resolves.toHaveLength(1);
        await expect(
            admin.query("SELECT * FROM public.unrelated"),
        ).resolves.toEqual([{ id: 1 }]);
    });

    test("preserves existing schema and rows without migration history", async () => {
        await admin.query('CREATE SCHEMA "legacy"');
        await admin.query(
            'CREATE TABLE "legacy"."example_entity" (id varchar PRIMARY KEY, value varchar NOT NULL, legacy_column varchar)',
        );
        await admin.query(
            'INSERT INTO "legacy"."example_entity" VALUES ($1, $2, $3)',
            ["existing", "keep-me", "keep-this-column"],
        );
        dataSource = createDataSource("legacy");
        await dataSource.initialize();

        await dataSource.runMigrations();

        await expect(
            dataSource.query('SELECT * FROM "legacy"."example_entity"'),
        ).resolves.toEqual([
            {
                id: "existing",
                value: "keep-me",
                legacy_column: "keep-this-column",
            },
        ]);
        await expect(dataSource.showMigrations()).resolves.toBe(false);
    });
});
