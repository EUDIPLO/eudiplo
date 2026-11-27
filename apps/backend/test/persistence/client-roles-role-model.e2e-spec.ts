import {
    PostgreSqlContainer,
    StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UpgradeClientRolesToRoleModel111786900000000 } from "../../src/database/migrations/1786900000000-UpgradeClientRolesToRoleModel11.js";
import { describeWithContainers } from "../container-runtime.js";

/**
 * The 11.0 client role upgrade on PostgreSQL, where `client_entity.roles` is a
 * `json` column that the driver returns parsed. The SQLite case is covered by
 * `src/database/client-roles-role-model-migration.spec.ts`.
 */
describeWithContainers("UpgradeClientRolesToRoleModel11 on PostgreSQL", () => {
    let dataSource: DataSource;
    let postgresContainer: StartedPostgreSqlContainer;

    const insert = (clientId: string, roles: string[]) =>
        dataSource.query(
            `INSERT INTO "client_entity" ("clientId", "roles") VALUES ($1, $2)`,
            [clientId, JSON.stringify(roles)],
        );
    const stored = async (clientId: string) => {
        const [row] = await dataSource.query(
            `SELECT "roles" FROM "client_entity" WHERE "clientId" = $1`,
            [clientId],
        );
        return row.roles;
    };

    beforeAll(async () => {
        const entities = await Promise.all([
            import("../../src/auth/tenant/entities/tenant.entity.js").then(
                (m) => m.TenantEntity,
            ),
            import("../../src/auth/client/entities/client.entity.js").then(
                (m) => m.ClientEntity,
            ),
        ]);
        postgresContainer = await new PostgreSqlContainer(
            "postgres:alpine",
        ).start();
        dataSource = new DataSource({
            type: "postgres",
            url: postgresContainer.getConnectionUri(),
            entities,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
    }, 60_000);

    afterAll(async () => {
        await dataSource?.destroy();
        await postgresContainer?.stop();
    });

    test("adds the split-off roles once and keeps admins unchanged", async () => {
        await insert("admin", ["clients:manage", "issuance:manage"]);
        await insert("owner", ["tenant:admin", "clients:manage"]);
        await insert("shop", ["issuance:offer"]);
        const migration = new UpgradeClientRolesToRoleModel111786900000000();
        const queryRunner = dataSource.createQueryRunner();

        await migration.up(queryRunner);
        await migration.up(queryRunner);
        await queryRunner.release();

        expect(await stored("admin")).toEqual([
            "clients:manage",
            "issuance:manage",
            "audit:read",
            "keys:manage",
        ]);
        expect(await stored("owner")).toEqual([
            "tenant:admin",
            "clients:manage",
        ]);
        expect(await stored("shop")).toEqual(["issuance:offer"]);
    });
});

describe("UpgradeClientRolesToRoleModel11 on SQLite", () => {
    test("adds the roles in the json column that TypeORM creates", async () => {
        const entities = await Promise.all([
            import("../../src/auth/tenant/entities/tenant.entity.js").then(
                (m) => m.TenantEntity,
            ),
            import("../../src/auth/client/entities/client.entity.js").then(
                (m) => m.ClientEntity,
            ),
        ]);
        const dataSource = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities,
            synchronize: true,
        }).initialize();
        await dataSource.query(
            `INSERT INTO "client_entity" ("clientId", "roles") VALUES (?, ?)`,
            ["verifier", JSON.stringify(["presentation:manage"])],
        );
        const queryRunner = dataSource.createQueryRunner();

        await new UpgradeClientRolesToRoleModel111786900000000().up(
            queryRunner,
        );
        await queryRunner.release();

        const [row] = await dataSource.query(
            `SELECT "roles" FROM "client_entity" WHERE "clientId" = ?`,
            ["verifier"],
        );
        expect(JSON.parse(row.roles)).toEqual([
            "presentation:manage",
            "keys:manage",
        ]);
        await dataSource.destroy();
    });
});
