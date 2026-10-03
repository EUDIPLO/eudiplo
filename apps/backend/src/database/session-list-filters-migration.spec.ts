import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../auth/client/entities/client.entity.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { Session } from "../session/entities/session.entity.js";
import { SessionLogEntry } from "../session/entities/session-log-entry.entity.js";
import { AddSessionListFilters1784300000000 } from "./migrations/1784300000000-AddSessionListFilters.js";

const entities = [Session, SessionLogEntry, TenantEntity, ClientEntity];
const indexes = [
    ["IDX_session_tenant_created_at", ["tenantId", "createdAt"]],
    ["IDX_session_tenant_reference", ["tenantId", "reference"]],
    ["IDX_session_tenant_request_id", ["tenantId", "requestId"]],
    ["IDX_session_tenant_status", ["tenantId", "status"]],
    ["IDX_session_tenant_updated_at", ["tenantId", "updatedAt"]],
    ["IDX_session_wallet_nonce", ["walletNonce"]],
];

/** Columns of the session table by name, independent of their order. */
async function sessionColumns(dataSource: DataSource) {
    const columns: { name: string; type: string; notnull: number }[] =
        await dataSource.query(`PRAGMA table_info("session")`);
    return columns
        .map(({ name, type, notnull }) => [name, type.toLowerCase(), notnull])
        .sort(([a], [b]) => String(a).localeCompare(String(b)));
}

/** The session table as `synchronize` creates it from the entity. */
async function entityColumns() {
    const reference = new DataSource({
        type: "better-sqlite3",
        database: ":memory:",
        entities,
        synchronize: true,
    });
    await reference.initialize();
    try {
        return await sessionColumns(reference);
    } finally {
        await reference.destroy();
    }
}

async function sessionIndexes(dataSource: DataSource) {
    const queryRunner = dataSource.createQueryRunner();
    try {
        const table = await queryRunner.getTable("session");
        return (table?.indices ?? [])
            .map((index) => [index.name, index.columnNames])
            .sort(([a], [b]) => String(a).localeCompare(String(b)));
    } finally {
        await queryRunner.release();
    }
}

describe("AddSessionListFilters1784300000000", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    test("adds the columns and indexes to an existing session table and keeps its rows", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities,
            synchronize: true,
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        const migration = new AddSessionListFilters1784300000000();
        await migration.down(queryRunner);
        expect(await sessionIndexes(dataSource)).toEqual([]);
        await dataSource.query(
            `INSERT INTO "tenant_entity" ("id", "name") VALUES ('t', 't')`,
        );
        await dataSource.query(
            `INSERT INTO "session" ("id", "tenantId", "requestId") VALUES ('3f2a0000-0000-4000-8000-000000000001', 't', 'age-check')`,
        );

        await migration.up(queryRunner);
        // Idempotent: a second run changes nothing.
        await migration.up(queryRunner);
        await queryRunner.release();

        expect(await sessionIndexes(dataSource)).toEqual(indexes);
        expect(
            await dataSource
                .getRepository(Session)
                .findOneByOrFail({ requestId: "age-check" }),
        ).toMatchObject({ reference: null, credentialConfigurationIds: null });
        // SQLite appends added columns, so compare independent of order.
        expect(await sessionColumns(dataSource)).toEqual(await entityColumns());
    });

    test("the entity declares the same indexes as the migration", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities,
            synchronize: true,
        });
        await dataSource.initialize();
        expect(await sessionIndexes(dataSource)).toEqual(indexes);
    });
});
