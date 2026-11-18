import { describe, expect, it } from "vitest";
import {
    AuditLogListQueryDto,
    AuditLogSearchQueryDto,
} from "./audit-log-query.dto.js";

describe("AuditLogListQueryDto", () => {
    const parse = (query: Record<string, unknown>) =>
        AuditLogListQueryDto.schema.safeParse(query);

    it.each([
        [undefined, 100],
        ["", 100],
        ["10", 10],
        ["10abc", 10],
        ["2.5", 2],
        ["abc", 100],
        ["0", 1],
        ["-5", 1],
        ["1000", 500],
    ])("reads limit %j as %d, as before the filters", (limit, expected) => {
        expect(parse(limit === undefined ? {} : { limit }).data?.limit).toBe(
            expected,
        );
    });

    it("ignores unknown parameters", () => {
        expect(parse({ unknown: "x" }).success).toBe(true);
    });

    it("accepts one or several action types", () => {
        expect(
            parse({ actionType: "tenant_updated" }).data?.actionType,
        ).toEqual(["tenant_updated"]);
        expect(
            parse({ actionType: ["tenant_updated", "session_cancelled"] }).data
                ?.actionType,
        ).toEqual(["tenant_updated", "session_cancelled"]);
    });

    it.each([
        { actionType: "unknown_action" },
        { objectType: "tenant_updated" },
        { actorType: "robot" },
        { from: "yesterday" },
        { from: "2026-01-01T00:00:00" },
        { actorId: "" },
        { requestId: "x".repeat(256) },
        { from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" },
    ])("rejects %j", (query) => {
        expect(parse(query).success).toBe(false);
    });

    it("reads the time range as dates", () => {
        expect(
            parse({
                from: "2026-01-01T10:00:00+01:00",
                to: "2026-01-01T10:00:00Z",
            }).data,
        ).toMatchObject({
            from: new Date("2026-01-01T09:00:00Z"),
            to: new Date("2026-01-01T10:00:00Z"),
        });
    });
});

describe("AuditLogSearchQueryDto", () => {
    const parse = (query: Record<string, unknown>) =>
        AuditLogSearchQueryDto.schema.safeParse(query);

    it("defaults to the first page of 25", () => {
        expect(parse({}).data).toEqual({ page: 1, pageSize: 25 });
    });

    it.each([
        { page: "0" },
        { pageSize: "101" },
        { limit: "10" },
        { objectType: "unknown" },
    ])("rejects %j", (query) => {
        expect(parse(query).success).toBe(false);
    });
});
