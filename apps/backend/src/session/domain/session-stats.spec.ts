import { describe, expect, it } from "vitest";
import { SessionStatus } from "./session-state.js";
import { sessionTypeStats } from "./session-stats.js";

describe("sessionTypeStats", () => {
    it("counts only the requested type and lists every status", () => {
        const lastCompletedAt = new Date("2026-10-10T08:00:00Z");

        const stats = sessionTypeStats(
            "issuance",
            [
                { type: "issuance", status: SessionStatus.Active, count: 3 },
                { type: "issuance", status: SessionStatus.Cancelled, count: 2 },
                {
                    type: "presentation",
                    status: SessionStatus.Completed,
                    count: 7,
                },
            ],
            lastCompletedAt,
        );

        expect(stats).toEqual({
            total: 5,
            byStatus: {
                active: 3,
                fetched: 0,
                completed: 0,
                expired: 0,
                failed: 0,
                cancelled: 2,
            },
            lastCompletedAt,
        });
    });

    it("returns zeros for a type without sessions", () => {
        const stats = sessionTypeStats("presentation", [], null);

        expect(stats.total).toBe(0);
        expect(Object.values(stats.byStatus)).toEqual(
            Object.values(SessionStatus).map(() => 0),
        );
        expect(stats.lastCompletedAt).toBeNull();
    });

    it("ignores stored statuses that are not a session status", () => {
        const stats = sessionTypeStats(
            "issuance",
            [
                { type: "issuance", status: SessionStatus.Failed, count: 1 },
                {
                    type: "issuance",
                    status: null as unknown as SessionStatus,
                    count: 4,
                },
            ],
            null,
        );

        expect(stats.total).toBe(1);
        expect(Object.keys(stats.byStatus)).toEqual(
            Object.values(SessionStatus),
        );
    });
});
