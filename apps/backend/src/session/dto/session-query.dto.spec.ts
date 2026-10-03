import { describe, expect, it } from "vitest";
import { SessionStatus } from "../domain/session-state.js";
import { SessionQueryDto } from "./session-query.dto.js";

const parse = (query: Record<string, unknown>) =>
    SessionQueryDto.schema.safeParse(query);

describe("SessionQueryDto", () => {
    it("accepts one or several statuses", () => {
        expect(parse({ status: "failed" }).data?.status).toEqual([
            SessionStatus.Failed,
        ]);
        expect(parse({ status: ["active", "fetched"] }).data?.status).toEqual([
            SessionStatus.Active,
            SessionStatus.Fetched,
        ]);
        expect(parse({ status: ["active", "pending"] }).success).toBe(false);
    });

    it("parses ISO 8601 timestamps with an offset", () => {
        expect(
            parse({
                createdFrom: "2026-10-02T08:00:00Z",
                createdTo: "2026-10-02T10:00:00+02:00",
            }).data,
        ).toMatchObject({
            createdFrom: new Date("2026-10-02T08:00:00Z"),
            createdTo: new Date("2026-10-02T08:00:00Z"),
        });
        for (const value of ["2026-10-02", "2026-10-02T08:00:00", "yesterday"])
            expect(parse({ updatedFrom: value }).success).toBe(false);
    });

    it("rejects a range that starts after it ends", () => {
        expect(
            parse({
                createdFrom: "2026-10-02T10:00:00Z",
                createdTo: "2026-10-02T08:00:00Z",
            }).success,
        ).toBe(false);
        expect(
            parse({
                updatedFrom: "2026-10-02T10:00:00Z",
                updatedTo: "2026-10-02T09:59:59Z",
            }).success,
        ).toBe(false);
        expect(
            parse({
                updatedFrom: "2026-10-02T10:00:00Z",
                updatedTo: "2026-10-02T10:00:00Z",
            }).success,
        ).toBe(true);
    });

    it("accepts only the beginning of a session id as id", () => {
        expect(parse({ id: "3f2a9c1e-7b" }).success).toBe(true);
        expect(parse({ id: "order-4711" }).success).toBe(false);
    });

    it("limits the length of identifiers and the search term", () => {
        expect(parse({ requestId: "a".repeat(255) }).success).toBe(true);
        expect(parse({ requestId: "a".repeat(256) }).success).toBe(false);
        expect(parse({ failureCode: "" }).success).toBe(false);
        expect(parse({ q: "a".repeat(4097) }).success).toBe(false);
    });

    it("allows sorting by updatedAt and rejects unknown parameters", () => {
        expect(parse({ sortBy: "updatedAt" }).success).toBe(true);
        expect(parse({ sortBy: "reference" }).success).toBe(false);
        expect(parse({ tenantId: "other" }).success).toBe(false);
    });
});
