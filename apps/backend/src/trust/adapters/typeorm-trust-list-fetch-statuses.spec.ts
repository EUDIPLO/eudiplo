import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientEntity } from "../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { TrustListFetchStatusEntity } from "../entities/trust-list-fetch-status.entity.js";
import { TypeOrmTrustListFetchStatuses } from "./typeorm-trust-list-fetch-statuses.js";

describe("TypeOrmTrustListFetchStatuses", () => {
    const url = "https://trust.example/list";
    const first = new Date("2026-11-16T10:00:00Z");
    const second = new Date("2026-11-16T11:00:00Z");
    let dataSource: DataSource;
    let statuses: TypeOrmTrustListFetchStatuses;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [TenantEntity, ClientEntity, TrustListFetchStatusEntity],
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.getRepository(TenantEntity).insert([
            { id: "t", name: "t" },
            { id: "u", name: "u" },
        ] as TenantEntity[]);
        statuses = new TypeOrmTrustListFetchStatuses(
            dataSource.getRepository(TrustListFetchStatusEntity),
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it("keeps the last verified details when a later fetch fails", async () => {
        await statuses.record(
            {
                tenantId: "t",
                url,
                outcome: "accepted",
                list: {
                    nextUpdate: "2026-12-01T00:00:00Z",
                    sequenceNumber: 7,
                    entities: 3,
                },
            },
            first,
        );
        await statuses.record(
            { tenantId: "t", url, outcome: "failed", reason: "HTTP 500" },
            second,
        );

        expect(await statuses.list("t")).toEqual([
            {
                url,
                trustListId: null,
                outcome: "failed",
                reason: "HTTP 500",
                checkedAt: second,
                verifiedAt: first,
                acceptedAt: first,
                nextUpdate: "2026-12-01T00:00:00Z",
                sequenceNumber: 7,
                entities: 3,
            },
        ]);
        expect(await statuses.list("u")).toEqual([]);
    });

    it("clears the reason once the list is accepted again", async () => {
        await statuses.record(
            { tenantId: "t", url, outcome: "failed", reason: "HTTP 500" },
            first,
        );
        await statuses.record(
            {
                tenantId: "t",
                url,
                outcome: "accepted",
                list: { nextUpdate: null, entities: 0 },
            },
            second,
        );

        expect(await statuses.list("t")).toMatchObject([
            {
                outcome: "accepted",
                reason: null,
                verifiedAt: second,
                acceptedAt: second,
                sequenceNumber: null,
            },
        ]);
    });

    it("lists the most recently checked first", async () => {
        await statuses.record(
            { tenantId: "t", url: "a", outcome: "accepted" },
            first,
        );
        await statuses.record(
            { tenantId: "t", url: "b", outcome: "accepted" },
            second,
        );
        expect((await statuses.list("t")).map((row) => row.url)).toEqual([
            "b",
            "a",
        ]);
    });

    it("keeps at most 1000 characters of a reason", async () => {
        await statuses.record(
            {
                tenantId: "t",
                url,
                outcome: "tooManyCertificates",
                reason: "r".repeat(1500),
            },
            first,
        );
        const [row] = await statuses.list("t");
        expect(row.reason).toHaveLength(1000);
    });
});
