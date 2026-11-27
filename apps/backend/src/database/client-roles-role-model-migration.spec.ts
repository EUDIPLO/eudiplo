import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UpgradeClientRolesToRoleModel111786900000000 } from "./migrations/1786900000000-UpgradeClientRolesToRoleModel11.js";

describe("UpgradeClientRolesToRoleModel111786900000000", () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        }).initialize();
        await dataSource.query(
            `CREATE TABLE "client_entity" ("clientId" varchar PRIMARY KEY NOT NULL, "roles" text NOT NULL)`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const insert = (clientId: string, roles: string[]) =>
        dataSource.query(
            `INSERT INTO "client_entity" ("clientId", "roles") VALUES (?, ?)`,
            [clientId, JSON.stringify(roles)],
        );
    const stored = async (clientId: string) => {
        const [row] = await dataSource.query(
            `SELECT "roles" FROM "client_entity" WHERE "clientId" = ?`,
            [clientId],
        );
        return JSON.parse(row.roles);
    };
    const run = () =>
        new UpgradeClientRolesToRoleModel111786900000000().up(
            dataSource.createQueryRunner(),
        );

    test("adds the roles that now hold the narrowed rights", async () => {
        await insert("admin", ["clients:manage", "issuance:manage"]);
        await insert("verifier", ["presentation:manage"]);
        await insert("shop", ["issuance:offer"]);
        await insert("tenant-admin", ["clients:manage", "tenant:admin"]);

        await run();

        expect(await stored("admin")).toEqual([
            "clients:manage",
            "issuance:manage",
            "audit:read",
            "keys:manage",
        ]);
        expect(await stored("verifier")).toEqual([
            "presentation:manage",
            "keys:manage",
        ]);
        expect(await stored("shop")).toEqual(["issuance:offer"]);
        expect(await stored("tenant-admin")).toEqual([
            "clients:manage",
            "tenant:admin",
        ]);
    });

    test("changes nothing on a second run", async () => {
        await insert("admin", ["clients:manage"]);
        await run();
        await run();
        expect(await stored("admin")).toEqual(["clients:manage", "audit:read"]);
    });

    test("does nothing without the roles column", async () => {
        const fresh = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        }).initialize();
        await expect(
            new UpgradeClientRolesToRoleModel111786900000000().up(
                fresh.createQueryRunner(),
            ),
        ).resolves.toBeUndefined();
        await fresh.destroy();
    });
});
