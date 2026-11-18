import type { ConfigService } from "@nestjs/config";
import { DataSource, Repository } from "typeorm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AuditActionType } from "./audit-action-types.js";
import { type AuditLogFilter, AuditLogService } from "./audit-log.service.js";
import { AuditLogEntity } from "./entities/audit-log.entity.js";

const DAY = 24 * 60 * 60 * 1000;

describe("AuditLogService", () => {
    let dataSource: DataSource;
    let repository: Repository<AuditLogEntity>;
    let settings: Record<string, number>;
    let service: AuditLogService;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [AuditLogEntity],
            synchronize: true,
        });
        await dataSource.initialize();
        repository = dataSource.getRepository(AuditLogEntity);
        settings = {};
        const config = {
            get: (key: string, fallback: number) => settings[key] ?? fallback,
        } as unknown as ConfigService;
        service = new AuditLogService(repository, config);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const add = (
        tenantId: string,
        actionType: AuditActionType,
        timestamp: Date,
        extra: Partial<AuditLogEntity> = {},
    ) =>
        repository.insert({
            tenantId,
            actionType,
            actorType: "client",
            timestamp,
            ...extra,
        });

    const list = (tenantId: string, filter: AuditLogFilter = {}) =>
        service.listByTenant(tenantId, filter, 500);

    const actions = (entries: AuditLogEntity[]) =>
        entries.map((entry) => entry.actionType);

    describe("filters", () => {
        beforeEach(async () => {
            await add(
                "t1",
                "oidc_client_created",
                new Date("2026-01-01T10:00:00Z"),
                {
                    actorId: "alice",
                    requestId: "req-1",
                },
            );
            await add(
                "t1",
                "oidc_client_secret_added",
                new Date("2026-01-01T11:00:00Z"),
                { actorId: "bob" },
            );
            await add(
                "t1",
                "tenant_updated",
                new Date("2026-01-01T12:00:00Z"),
                {
                    actorType: "user",
                    actorId: "alice",
                },
            );
            await add(
                "t1",
                "config_bundle_imported",
                new Date("2026-01-01T13:00:00Z"),
            );
            await add(
                "t2",
                "oidc_client_created",
                new Date("2026-01-01T10:30:00Z"),
            );
        });

        test("lists only the tenant's entries, newest first", async () => {
            expect(actions(await list("t1"))).toEqual([
                "config_bundle_imported",
                "tenant_updated",
                "oidc_client_secret_added",
                "oidc_client_created",
            ]);
        });

        test("filters by time range, inclusive", async () => {
            const entries = await list("t1", {
                from: new Date("2026-01-01T10:30:00Z"),
                to: new Date("2026-01-01T12:30:00Z"),
            });
            expect(actions(entries)).toEqual([
                "tenant_updated",
                "oidc_client_secret_added",
            ]);
            expect(
                actions(
                    await list("t1", {
                        from: new Date("2026-01-01T12:30:00Z"),
                    }),
                ),
            ).toEqual(["config_bundle_imported"]);
            expect(
                actions(
                    await list("t1", {
                        to: new Date("2026-01-01T10:30:00Z"),
                    }),
                ),
            ).toEqual(["oidc_client_created"]);
        });

        test("filters by several action types", async () => {
            const entries = await list("t1", {
                actionType: ["tenant_updated", "oidc_client_created"],
            });
            expect(actions(entries)).toEqual([
                "tenant_updated",
                "oidc_client_created",
            ]);
        });

        test("an object type matches its own actions only", async () => {
            expect(
                actions(
                    await list("t1", {
                        objectType: "oidc_client",
                    }),
                ),
            ).toEqual(["oidc_client_created"]);
            expect(
                actions(
                    await list("t1", {
                        objectType: "config_bundle",
                    }),
                ),
            ).toEqual(["config_bundle_imported"]);
        });

        test("object type and action type must both match", async () => {
            expect(
                await list("t1", {
                    objectType: "tenant",
                    actionType: ["oidc_client_created"],
                }),
            ).toEqual([]);
            expect(
                await service.pageByTenant(
                    "t1",
                    {
                        objectType: "tenant",
                        actionType: ["oidc_client_created"],
                    },
                    1,
                    10,
                ),
            ).toEqual({
                items: [],
                total: 0,
                page: 1,
                pageSize: 10,
                totalPages: 0,
            });
        });

        test("filters by actor and request id", async () => {
            expect(
                actions(
                    await list("t1", {
                        actorType: "user",
                    }),
                ),
            ).toEqual(["tenant_updated"]);
            expect(
                actions(
                    await list("t1", {
                        actorId: "alice",
                    }),
                ),
            ).toEqual(["tenant_updated", "oidc_client_created"]);
            expect(
                actions(
                    await list("t1", {
                        requestId: "req-1",
                    }),
                ),
            ).toEqual(["oidc_client_created"]);
        });

        test("a filter never reaches another tenant", async () => {
            expect(
                (
                    await list("t2", {
                        actorId: "alice",
                    })
                ).length,
            ).toBe(0);
        });

        test("pages through the matching entries", async () => {
            const second = await service.pageByTenant("t1", {}, 2, 3);
            expect(second).toMatchObject({
                total: 4,
                page: 2,
                pageSize: 3,
                totalPages: 2,
            });
            expect(actions(second.items)).toEqual(["oidc_client_created"]);
        });

        test("returns at most limit entries", async () => {
            expect(await service.listByTenant("t1", {}, 2)).toHaveLength(2);
        });
    });

    describe("pruning", () => {
        const pruned = async (tenantId: string) =>
            repository.find({
                where: { tenantId, actionType: "audit_log_pruned" },
            });

        test("does nothing when no limit is set", async () => {
            await add("t1", "tenant_updated", new Date(Date.now() - 400 * DAY));
            await service.pruneOldLogs();
            expect(await repository.count()).toBe(1);
        });

        test("deletes entries older than the retention and records it per tenant", async () => {
            settings.AUDIT_LOG_RETENTION_DAYS = 30;
            await add("t1", "tenant_updated", new Date(Date.now() - 40 * DAY));
            await add("t1", "tenant_updated", new Date(Date.now() - 35 * DAY));
            await add("t1", "tenant_created", new Date(Date.now() - DAY));
            await add("t2", "tenant_created", new Date(Date.now() - DAY));

            await service.pruneOldLogs();

            expect(actions(await list("t1")).sort()).toEqual([
                "audit_log_pruned",
                "tenant_created",
            ]);
            const [record] = await pruned("t1");
            expect(record).toMatchObject({
                actorType: "system",
                after: {
                    deletedEntries: 2,
                    retentionDays: 30,
                    olderThan: expect.any(String),
                },
            });
            // A tenant without old entries gets no record.
            expect(await pruned("t2")).toEqual([]);
        });

        test("keeps the newest entries per tenant, the record included", async () => {
            settings.AUDIT_LOG_MAX_ENTRIES_PER_TENANT = 3;
            for (let i = 5; i > 0; i--) {
                await add(
                    "t1",
                    "tenant_updated",
                    new Date(Date.now() - i * DAY),
                    {
                        actorId: `actor-${i}`,
                    },
                );
            }
            await add("t2", "tenant_updated", new Date());

            await service.pruneOldLogs();

            const remaining = await list("t1");
            expect(remaining).toHaveLength(3);
            expect(remaining.slice(1).map((entry) => entry.actorId)).toEqual([
                "actor-1",
                "actor-2",
            ]);
            expect(remaining[0]).toMatchObject({
                actionType: "audit_log_pruned",
                after: { deletedEntries: 3, maxEntriesPerTenant: 3 },
            });
            expect(await repository.count({ where: { tenantId: "t2" } })).toBe(
                1,
            );

            // The record fills the last place: the next run prunes nothing.
            await service.pruneOldLogs();
            expect(await pruned("t1")).toHaveLength(1);
        });

        test("prunes ties of the same second by id, as the list orders them", async () => {
            settings.AUDIT_LOG_MAX_ENTRIES_PER_TENANT = 2;
            const sameSecond = new Date(Date.now() - DAY);
            for (let i = 0; i < 4; i++) {
                await add("t1", "tenant_updated", sameSecond);
            }
            const [newest] = await list("t1");

            await service.pruneOldLogs();

            const remaining = await list("t1");
            expect(remaining.map((entry) => entry.actionType)).toEqual([
                "audit_log_pruned",
                "tenant_updated",
            ]);
            expect(remaining[1].id).toBe(newest.id);
        });
    });

    describe("pruning edge cases", () => {
        const all = (tenantId: string) => list(tenantId);

        test("an aged pruning record alone is removed without a new record", async () => {
            settings.AUDIT_LOG_RETENTION_DAYS = 30;
            await add(
                "t1",
                "audit_log_pruned",
                new Date(Date.now() - 40 * DAY),
            );

            await service.pruneOldLogs();

            expect(await all("t1")).toEqual([]);
        });

        test("old pruning records are removed but not counted", async () => {
            settings.AUDIT_LOG_RETENTION_DAYS = 30;
            await add(
                "t1",
                "audit_log_pruned",
                new Date(Date.now() - 40 * DAY),
            );
            await add("t1", "tenant_updated", new Date(Date.now() - 40 * DAY));

            await service.pruneOldLogs();

            const [record, ...rest] = await all("t1");
            expect(rest).toEqual([]);
            expect(record).toMatchObject({
                actionType: "audit_log_pruned",
                after: { deletedEntries: 1, retentionDays: 30 },
            });
        });

        test("both limits together write one record and keep the newest entry", async () => {
            settings.AUDIT_LOG_RETENTION_DAYS = 30;
            settings.AUDIT_LOG_MAX_ENTRIES_PER_TENANT = 2;
            await add("t1", "tenant_updated", new Date(Date.now() - 40 * DAY));
            for (let i = 3; i > 0; i--) {
                await add(
                    "t1",
                    "tenant_updated",
                    new Date(Date.now() - i * DAY),
                    {
                        actorId: `actor-${i}`,
                    },
                );
            }

            await service.pruneOldLogs();

            const [record, ...rest] = await all("t1");
            expect(record).toMatchObject({
                actionType: "audit_log_pruned",
                after: {
                    deletedEntries: 3,
                    retentionDays: 30,
                    maxEntriesPerTenant: 2,
                },
            });
            expect(rest.map((entry) => entry.actorId)).toEqual(["actor-1"]);
        });

        test("earlier pruning records over the limit are deleted but not counted", async () => {
            settings.AUDIT_LOG_MAX_ENTRIES_PER_TENANT = 1;
            await add("t1", "audit_log_pruned", new Date(Date.now() - 2 * DAY));
            await add("t1", "tenant_updated", new Date(Date.now() - DAY));

            await service.pruneOldLogs();

            expect(await all("t1")).toEqual([
                expect.objectContaining({
                    actionType: "audit_log_pruned",
                    after: { deletedEntries: 1, maxEntriesPerTenant: 1 },
                }),
            ]);
        });

        test("a limit of one keeps only the pruning record", async () => {
            settings.AUDIT_LOG_MAX_ENTRIES_PER_TENANT = 1;
            for (let i = 3; i > 0; i--) {
                await add(
                    "t1",
                    "tenant_updated",
                    new Date(Date.now() - i * DAY),
                );
            }

            await service.pruneOldLogs();

            expect(await all("t1")).toEqual([
                expect.objectContaining({
                    actionType: "audit_log_pruned",
                    after: expect.objectContaining({ deletedEntries: 3 }),
                }),
            ]);
        });
    });

    test("reports the retention limits", () => {
        settings.AUDIT_LOG_RETENTION_DAYS = 365;
        expect(service.retention()).toEqual({
            retentionDays: 365,
            maxEntriesPerTenant: 0,
        });
    });
});
