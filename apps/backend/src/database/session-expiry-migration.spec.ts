import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { afterEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../auth/client/entities/client.entity.js";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { IssuanceConfig } from "../issuer/configuration/issuance/entities/issuance-config.entity.js";
import { Session } from "../session/entities/session.entity.js";
import { SessionLogEntry } from "../session/entities/session-log-entry.entity.js";
import { BaselineMigration1740000000000 } from "./migrations/1740000000000-BaselineMigration.js";
import { ChangeSessionExpiresAtToTimestamp1784000000000 } from "./migrations/1784000000000-ChangeSessionExpiresAtToTimestamp.js";
import { AddOfferLifetimeToIssuanceConfig1784100000000 } from "./migrations/1784100000000-AddOfferLifetimeToIssuanceConfig.js";

const entities = [
    Session,
    SessionLogEntry,
    TenantEntity,
    ClientEntity,
    IssuanceConfig,
];

function sqlite(options: Partial<{ synchronize: boolean }> = {}) {
    return new DataSource({
        type: "better-sqlite3",
        database: ":memory:",
        entities,
        migrations: [
            BaselineMigration1740000000000,
            ChangeSessionExpiresAtToTimestamp1784000000000,
            AddOfferLifetimeToIssuanceConfig1784100000000,
        ],
        migrationsTableName: "typeorm_migrations",
        synchronize: options.synchronize ?? false,
    });
}

/** Pending schema-sync statements, i.e. differences to the entity metadata. */
async function drift(dataSource: DataSource): Promise<string[]> {
    const pending = await dataSource.driver.createSchemaBuilder().log();
    return pending.upQueries.map((query) => query.query);
}

/**
 * The drift of a schema created by `synchronize` itself: TypeORM's SQLite
 * builder always proposes to recreate some tables (e.g. `session`), so the
 * migrated schema must not differ more than that.
 */
async function referenceDrift(): Promise<string[]> {
    const reference = sqlite({ synchronize: true });
    await reference.initialize();
    try {
        return await drift(reference);
    } finally {
        await reference.destroy();
    }
}

async function columnType(
    dataSource: DataSource,
    table: string,
    column: string,
): Promise<string | undefined> {
    const columns: { name: string; type: string }[] = await dataSource.query(
        `PRAGMA table_info("${table}")`,
    );
    return columns
        .find((candidate) => candidate.name === column)
        ?.type.toLowerCase();
}

describe("session expiry migrations", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    test("a fresh database bootstrapped through migrations matches the entities", async () => {
        dataSource = sqlite();
        await dataSource.initialize();

        await dataSource.runMigrations();

        expect(await columnType(dataSource, "session", "expiresAt")).toBe(
            "datetime",
        );
        expect(
            await columnType(
                dataSource,
                "issuance_config",
                "offerLifetimeSeconds",
            ),
        ).toBe("integer");
        expect(await drift(dataSource)).toEqual(await referenceDrift());
    });

    test("converts a date-only expiresAt to midnight and keeps related rows", async () => {
        dataSource = sqlite({ synchronize: true });
        await dataSource.initialize();
        // Recreate the pre-migration schema: expiresAt stored as `date`.
        const queryRunner = dataSource.createQueryRunner();
        await new ChangeSessionExpiresAtToTimestamp1784000000000().down(
            queryRunner,
        );
        await new AddOfferLifetimeToIssuanceConfig1784100000000().down(
            queryRunner,
        );
        await queryRunner.release();
        expect(await columnType(dataSource, "session", "expiresAt")).toBe(
            "date",
        );
        expect(
            await columnType(
                dataSource,
                "issuance_config",
                "offerLifetimeSeconds",
            ),
        ).toBeUndefined();

        const id = randomUUID();
        const withoutExpiry = randomUUID();
        await dataSource.query(
            `INSERT INTO "tenant_entity" ("id", "name") VALUES ('t', 't')`,
        );
        await dataSource.query(
            `INSERT INTO "session" ("id", "tenantId", "expiresAt") VALUES (?, 't', '2026-03-01'), (?, 't', NULL)`,
            [id, withoutExpiry],
        );
        await dataSource.query(
            `INSERT INTO "session_log_entry" ("id", "sessionId", "level", "message") VALUES (?, ?, 'info', 'kept')`,
            [randomUUID(), id],
        );

        // The migration runner disables foreign keys while it recreates the table.
        await dataSource.runMigrations();

        const repository = dataSource.getRepository(Session);
        expect((await repository.findOneByOrFail({ id })).expiresAt).toEqual(
            new Date("2026-03-01T00:00:00.000Z"),
        );
        expect(
            (await repository.findOneByOrFail({ id: withoutExpiry })).expiresAt,
        ).toBeNull();
        await expect(
            dataSource.query(`SELECT "message" FROM "session_log_entry"`),
        ).resolves.toEqual([{ message: "kept" }]);
        expect(await columnType(dataSource, "session", "expiresAt")).toBe(
            "datetime",
        );
        expect(await drift(dataSource)).toEqual(await referenceDrift());

        // Times survive a round trip, and comparisons use the same format.
        const later = new Date("2026-03-01T10:15:30.250Z");
        await repository.update(id, { expiresAt: later });
        expect((await repository.findOneByOrFail({ id })).expiresAt).toEqual(
            later,
        );
    });

    test("both migrations are idempotent", async () => {
        dataSource = sqlite({ synchronize: true });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();

        await new ChangeSessionExpiresAtToTimestamp1784000000000().up(
            queryRunner,
        );
        await new AddOfferLifetimeToIssuanceConfig1784100000000().up(
            queryRunner,
        );
        await queryRunner.release();

        expect(await drift(dataSource)).toEqual(await referenceDrift());
    });
});
