import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NormalizeTrustListEntityInfo1786100000000 } from "./migrations/1786100000000-NormalizeTrustListEntityInfo.js";

describe("NormalizeTrustListEntityInfo1786100000000", () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        }).initialize();
        await dataSource.query(
            `CREATE TABLE "trust_list" ("id" varchar NOT NULL, "tenantId" varchar NOT NULL, "entityConfig" text, PRIMARY KEY ("id", "tenantId"))`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
        vi.restoreAllMocks();
    });

    const insert = (id: string, tenantId: string, value: unknown) =>
        dataSource.query(
            `INSERT INTO "trust_list" ("id", "tenantId", "entityConfig") VALUES (?, ?, ?)`,
            [id, tenantId, value === null ? null : JSON.stringify(value)],
        );
    const stored = async (id: string, tenantId: string) => {
        const [row] = await dataSource.query(
            `SELECT "entityConfig" FROM "trust_list" WHERE "id" = ? AND "tenantId" = ?`,
            [id, tenantId],
        );
        return row.entityConfig === null ? null : JSON.parse(row.entityConfig);
    };
    const entity = (info: Record<string, unknown>) => ({
        type: "internal",
        issuerKeyChainId: "issuer",
        revocationKeyChainId: "status",
        info: {
            name: "Example",
            contactUri: "info@example.com",
            website: "https://example.com/",
            ...info,
        },
    });
    const run = async () => {
        const queryRunner = dataSource.createQueryRunner();
        const migration = new NormalizeTrustListEntityInfo1786100000000();
        await migration.up(queryRunner);
        await migration.up(queryRunner);
        await queryRunner.release();
    };

    test("fixes the case of country and lang and keeps the rest", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
        await insert("list", "a", [
            entity({ country: "de", lang: "DE-AT", locality: "Berlin" }),
            entity({ country: "gb", uri: "https://example.com/a b" }),
            entity({ country: "Germany", lang: "en_US" }),
        ]);
        await insert("list", "b", [entity({ country: "AT", lang: "de" })]);
        await insert("empty", "a", null);

        await run();

        await expect(stored("list", "a")).resolves.toEqual([
            entity({ country: "DE", lang: "de-at", locality: "Berlin" }),
            entity({ country: "UK", uri: "https://example.com/a b" }),
            entity({ country: "Germany", lang: "en_US" }),
        ]);
        await expect(stored("list", "b")).resolves.toEqual([
            entity({ country: "AT", lang: "de" }),
        ]);
        await expect(stored("empty", "a")).resolves.toBeNull();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "a/list entities.1.info.uri, a/list entities.2.info.country, a/list entities.2.info.lang",
            ),
        );
    });

    test("logs a missing or invalid e-mail address and web site", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const value = [
            entity({ contactUri: undefined, website: undefined }),
            entity({ contactUri: "https://example.com/contact" }),
            entity({ website: "example.com" }),
            entity({ contactUri: "mailto:info@example.com" }),
        ];
        await insert("list", "a", value);

        await run();

        await expect(stored("list", "a")).resolves.toEqual(
            JSON.parse(JSON.stringify(value)),
        );
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "a/list entities.0.info.contactUri, a/list entities.0.info.website, a/list entities.1.info.contactUri, a/list entities.2.info.website",
            ),
        );
        expect(warn.mock.calls.flat().join()).not.toContain("entities.3");
    });

    test("skips databases without the trust_list table", async () => {
        await dataSource.query(`DROP TABLE "trust_list"`);
        const queryRunner = dataSource.createQueryRunner();
        await expect(
            new NormalizeTrustListEntityInfo1786100000000().up(queryRunner),
        ).resolves.toBeUndefined();
        await queryRunner.release();
    });
});
