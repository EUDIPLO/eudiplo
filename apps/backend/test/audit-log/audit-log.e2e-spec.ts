import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AuditLogService } from "../../src/audit-log/audit-log.service.js";
import { getToken, setupIssuanceTestApp } from "../utils.js";

describe("Audit log filters, search and retention", () => {
    let app: INestApplication<App>;
    let rootToken: string;
    let otherToken: string;
    let auditLog: AuditLogService;

    const get = (path: string, token = rootToken) =>
        request(app.getHttpServer())
            .get(path)
            .trustLocalhost()
            .set("Authorization", `Bearer ${token}`);
    const search = async (query: string, token = rootToken) =>
        (await get(`/admin/audit-logs/search?${query}`, token).expect(200))
            .body;
    const actionsOf = (items: { actionType: string }[]) =>
        items.map((item) => item.actionType);

    beforeAll(async () => {
        const context = await setupIssuanceTestApp();
        app = context.app;
        rootToken = context.authToken;
        // Creating the tenant records `tenant_created` in it.
        otherToken = await getToken(
            app,
            context.clientId,
            context.clientSecret,
            "audit-other",
        );
        auditLog = app.get(AuditLogService);
        await auditLog.record({
            tenantId: "root",
            actionType: "webhook_endpoint_deleted",
            actor: { type: "user", id: "alice", display: "Alice" },
            requestMeta: { requestId: "req-audit-e2e" },
        });
        await auditLog.record({
            tenantId: "root",
            actionType: "oidc_client_secret_added",
            actor: { type: "client", id: "ops-client" },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    test("pages through the tenant's entries, newest first", async () => {
        const all = await search("pageSize=100");
        expect(all.total).toBeGreaterThanOrEqual(3);
        expect(all).toMatchObject({ page: 1, pageSize: 100, totalPages: 1 });
        // SQLite stores whole seconds, so entries of one second come in id
        // order; only the set is certain here.
        expect(actionsOf(all.items)).toEqual(
            expect.arrayContaining([
                "oidc_client_secret_added",
                "webhook_endpoint_deleted",
                "tenant_created",
            ]),
        );

        const second = await search("pageSize=1&page=2");
        expect(second.total).toBe(all.total);
        expect(second.items).toEqual([all.items[1]]);
    });

    test("filters by action, object, actor and request id", async () => {
        expect(
            actionsOf(
                (
                    await search(
                        "actionType=webhook_endpoint_deleted&actionType=tenant_created",
                    )
                ).items,
            ).sort(),
        ).toEqual(["tenant_created", "webhook_endpoint_deleted"]);
        expect(
            actionsOf((await search("objectType=oidc_client")).items),
        ).toEqual([]);
        expect(
            actionsOf((await search("objectType=oidc_client_secret")).items),
        ).toEqual(["oidc_client_secret_added"]);
        expect((await search("actorType=user&actorId=alice")).items).toEqual([
            expect.objectContaining({
                actionType: "webhook_endpoint_deleted",
                actorDisplay: "Alice",
                requestId: "req-audit-e2e",
            }),
        ]);
        expect((await search("requestId=req-audit-e2e")).total).toBe(1);
        expect(actionsOf((await search("q=ALICE")).items)).toEqual([
            "webhook_endpoint_deleted",
        ]);
        expect(actionsOf((await search("q=Endpoint%20Deleted")).items)).toEqual(
            ["webhook_endpoint_deleted"],
        );
    });

    test("filters by time range", async () => {
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        expect((await search(`from=${encodeURIComponent(future)}`)).total).toBe(
            0,
        );
        expect((await search(`to=${encodeURIComponent(past)}`)).total).toBe(0);
        expect(
            (
                await search(
                    `from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}&actionType=webhook_endpoint_deleted`,
                )
            ).total,
        ).toBe(1);
    });

    test("never shows another tenant's entries", async () => {
        const other = await search("pageSize=100", otherToken);
        expect(actionsOf(other.items)).toEqual(["tenant_created"]);
        expect(
            (await search("requestId=req-audit-e2e", otherToken)).total,
        ).toBe(0);
    });

    test.each([
        "from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z",
        "from=yesterday",
        "actionType=unknown",
        "objectType=unknown",
        "pageSize=101",
        "tenantId=audit-other",
    ])("rejects %s", async (query) => {
        await get(`/admin/audit-logs/search?${query}`).expect(400);
    });

    test("the list endpoint takes the same filters and stays an array", async () => {
        const { body } = await get(
            "/admin/audit-logs?limit=5&actorId=alice&unknown=ignored",
        ).expect(200);
        expect(actionsOf(body)).toEqual(["webhook_endpoint_deleted"]);
        await get("/admin/audit-logs?actionType=unknown").expect(400);
    });

    test("reports the retention and records pruning in the tenant's log", async () => {
        expect(
            (await get("/admin/audit-logs/retention").expect(200)).body,
        ).toEqual({ retentionDays: 0, maxEntriesPerTenant: 0 });

        const config = app.get(ConfigService);
        config.set("AUDIT_LOG_MAX_ENTRIES_PER_TENANT", 2);
        try {
            expect(
                (await get("/admin/audit-logs/retention").expect(200)).body,
            ).toEqual({ retentionDays: 0, maxEntriesPerTenant: 2 });
            await auditLog.pruneOldLogs();
        } finally {
            config.set("AUDIT_LOG_MAX_ENTRIES_PER_TENANT", 0);
        }

        const root = await search("pageSize=100");
        expect(root.total).toBe(2);
        expect((await search("objectType=audit_log")).items).toEqual([
            expect.objectContaining({
                actionType: "audit_log_pruned",
                actorType: "system",
                after: expect.objectContaining({ maxEntriesPerTenant: 2 }),
            }),
        ]);
        // The other tenant had one entry, within the limit.
        expect(actionsOf((await search("", otherToken)).items)).toEqual([
            "tenant_created",
        ]);
    });
});
