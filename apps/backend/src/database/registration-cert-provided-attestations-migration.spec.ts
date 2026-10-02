import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RemoveRegistrationCertProvidedAttestations1784200000000 } from "./migrations/1784200000000-RemoveRegistrationCertProvidedAttestations.js";

describe("RemoveRegistrationCertProvidedAttestations1784200000000", () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = await new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        }).initialize();
        await dataSource.query(
            `CREATE TABLE "presentation_config" ("id" varchar NOT NULL, "tenantId" varchar NOT NULL, "registration_cert" text, PRIMARY KEY ("id", "tenantId"))`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const insert = (id: string, tenantId: string, value: unknown) =>
        dataSource.query(
            `INSERT INTO "presentation_config" ("id", "tenantId", "registration_cert") VALUES (?, ?, ?)`,
            [id, tenantId, value === null ? null : JSON.stringify(value)],
        );
    const stored = async (id: string, tenantId: string) => {
        const [row] = await dataSource.query(
            `SELECT "registration_cert" FROM "presentation_config" WHERE "id" = ? AND "tenantId" = ?`,
            [id, tenantId],
        );
        return row.registration_cert === null
            ? null
            : JSON.parse(row.registration_cert);
    };

    test("removes provided_attestations and keeps everything else", async () => {
        const body = {
            privacy_policy: "https://verifier.example/privacy",
            support_uri: "https://verifier.example/support",
        };
        await insert("legacy", "a", {
            id: "cert",
            body: { ...body, provided_attestations: [{ vct: "urn:x" }] },
        });
        await insert("legacy", "b", {
            body: { ...body, provides_attestations: ["urn:y"] },
        });
        await insert("jwt", "a", { jwt: "eyJ" });
        await insert("none", "a", null);

        const queryRunner = dataSource.createQueryRunner();
        const migration =
            new RemoveRegistrationCertProvidedAttestations1784200000000();
        await migration.up(queryRunner);
        await migration.up(queryRunner);
        await queryRunner.release();

        await expect(stored("legacy", "a")).resolves.toEqual({
            id: "cert",
            body,
        });
        await expect(stored("legacy", "b")).resolves.toEqual({
            body: { ...body, provides_attestations: ["urn:y"] },
        });
        await expect(stored("jwt", "a")).resolves.toEqual({ jwt: "eyJ" });
        await expect(stored("none", "a")).resolves.toBeNull();
    });

    test("skips databases without the presentation_config table", async () => {
        await dataSource.query(`DROP TABLE "presentation_config"`);
        const queryRunner = dataSource.createQueryRunner();
        await expect(
            new RemoveRegistrationCertProvidedAttestations1784200000000().up(
                queryRunner,
            ),
        ).resolves.toBeUndefined();
        await queryRunner.release();
    });
});
