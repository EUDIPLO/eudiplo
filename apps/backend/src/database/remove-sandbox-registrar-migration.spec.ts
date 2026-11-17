import { DataSource } from "typeorm";
import { afterEach, describe, expect, it } from "vitest";
import { AddConfigResourceMetadata1777000000000 } from "./migrations/1777000000000-AddConfigResourceMetadata.js";
import {
    issuerRegistrationCertificate,
    presentationRegistrationCertificate,
    RemoveSandboxRegistrar1786400000000,
} from "./migrations/1786400000000-RemoveSandboxRegistrar.js";

const NOW = 1_800_000_000;
const unsigned = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
const valid = unsigned({ exp: NOW + 3600 });
const expired = unsigned({ exp: NOW - 3600 });
const purpose = [{ lang: "en", content: "Age check" }];

describe("RemoveSandboxRegistrar1786400000000 presentation configurations", () => {
    it("keeps a valid cached certificate for id or body and moves purpose and privacy policy up", () => {
        expect(
            presentationRegistrationCertificate(
                {
                    id: "cert-1",
                    body: {
                        purpose,
                        privacy_policy: "https://rp.example/privacy",
                        support_uri: "https://rp.example/support",
                    },
                },
                { jwt: valid },
                NOW,
            ),
        ).toEqual({
            value: {
                jwt: valid,
                purpose,
                privacy_policy: "https://rp.example/privacy",
            },
            note: expect.stringMatching(/kept the registration certificate/),
        });
    });

    it("drops an expired, missing or undecodable cache and says a certificate must be requested", () => {
        for (const cache of [{ jwt: expired }, null, { jwt: "not-a-jwt" }]) {
            expect(
                presentationRegistrationCertificate(
                    { body: { purpose } },
                    cache,
                    NOW,
                ),
            ).toEqual({
                value: { purpose },
                note: expect.stringMatching(/request one from the EUDI Hub/),
            });
        }
        expect(
            presentationRegistrationCertificate({ id: "x" }, null, NOW).value,
        ).toBeNull();
    });

    it("prefers an imported JWT over the cache of id or body", () => {
        expect(
            presentationRegistrationCertificate(
                { jwt: "imported", id: "x" },
                { jwt: valid },
                NOW,
            ),
        ).toEqual({ value: { jwt: "imported" }, note: undefined });
    });

    it("drops purpose entries without language or text", () => {
        expect(
            presentationRegistrationCertificate(
                {
                    jwt: valid,
                    body: {
                        purpose: [
                            ...purpose,
                            { lang: "de" },
                            { content: "x" },
                            { lang: "", content: "x" },
                            "text",
                        ],
                    },
                },
                null,
                NOW,
            ).value,
        ).toEqual({ jwt: valid, purpose });
    });

    it("keeps values already migrated over those under body, so a second run changes nothing", () => {
        const migrated = {
            jwt: valid,
            purpose,
            privacy_policy: "https://rp.example/privacy",
        };
        expect(
            presentationRegistrationCertificate(migrated, null, NOW).value,
        ).toEqual(migrated);
        expect(
            presentationRegistrationCertificate(
                {
                    ...migrated,
                    body: {
                        purpose: [{ lang: "de", content: "Anders" }],
                        privacy_policy: "https://other.example",
                    },
                },
                null,
                NOW,
            ).value,
        ).toEqual(migrated);
    });
});

describe("RemoveSandboxRegistrar1786400000000 issuance configurations", () => {
    it("keeps an imported certificate and drops mode and renewal", () => {
        expect(
            issuerRegistrationCertificate(
                { enabled: true, mode: "import", renewal: "manual", jwt: "a" },
                { jwt: valid },
                NOW,
            ),
        ).toEqual({ value: { enabled: true, jwt: "a" } });
    });

    it("serves the valid generated certificate instead of a stale jwt in generate mode", () => {
        expect(
            issuerRegistrationCertificate(
                { enabled: true, mode: "generate", jwt: "stale" },
                { jwt: valid },
                NOW,
            ),
        ).toEqual({
            value: { enabled: true, jwt: valid },
            note: expect.stringMatching(/kept the issuer registration/),
        });
    });

    it("drops the jwt of the default mode when the generated certificate has expired", () => {
        expect(
            issuerRegistrationCertificate(
                { enabled: true, jwt: "stale" },
                { jwt: expired },
                NOW,
            ),
        ).toEqual({
            value: { enabled: true },
            note: expect.stringMatching(/no longer generates/),
        });
        expect(
            issuerRegistrationCertificate({ enabled: false }, null, NOW),
        ).toEqual({ value: { enabled: false }, note: undefined });
    });
});

describe("RemoveSandboxRegistrar1786400000000 ownership records", () => {
    let dataSource: DataSource | undefined;

    afterEach(async () => {
        await dataSource?.destroy();
        dataSource = undefined;
    });

    it("removes the records of registrar configurations and keeps the others", async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
        });
        await dataSource.initialize();
        const queryRunner = dataSource.createQueryRunner();
        await new AddConfigResourceMetadata1777000000000().up(queryRunner);
        await queryRunner.query(`
            INSERT INTO "config_resource_metadata"
                ("tenantId", "kind", "resourceId", "ownership", "generation")
            VALUES ('t', 'RegistrarConfig', 'registrar', 'file-managed', 1),
                   ('t', 'KeyChain', 'issuer', 'file-managed', 1)
        `);

        const migration = new RemoveSandboxRegistrar1786400000000();
        await migration.up(queryRunner);
        await migration.up(queryRunner);

        expect(
            await queryRunner.query(
                `SELECT "kind" FROM "config_resource_metadata"`,
            ),
        ).toEqual([{ kind: "KeyChain" }]);
        await queryRunner.release();
    });
});
