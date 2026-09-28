import { describe, expect, it, vi } from "vitest";
import { SessionStatus } from "../domain/session-state.js";
import { InitializeSessionMetrics } from "./initialize-session-metrics.js";

describe("InitializeSessionMetrics", () => {
    it("initializes both kinds and every status for each tenant, including zero counts", async () => {
        const countSessionsForMaintenance = vi.fn(async () => 0);
        const recordInitialCount = vi.fn();
        await new InitializeSessionMetrics(
            { countSessionsForMaintenance },
            {
                listForMaintenance: async () => [
                    { tenantId: "a" },
                    { tenantId: "b" },
                ],
            },
            { recordInitialCount },
        ).execute();
        expect(countSessionsForMaintenance).toHaveBeenCalledTimes(20);
        expect(recordInitialCount).toHaveBeenCalledTimes(20);
        for (const tenant of ["a", "b"]) {
            for (const status of Object.values(SessionStatus)) {
                for (const kind of ["issuance", "verification"]) {
                    expect(countSessionsForMaintenance).toHaveBeenCalledWith(
                        tenant,
                        kind,
                        status,
                    );
                    expect(recordInitialCount).toHaveBeenCalledWith(
                        tenant,
                        kind,
                        status,
                        0,
                    );
                }
            }
        }
    });

    it("does not emit a misleading count when persistence fails", async () => {
        const error = new Error("count failed");
        const recordInitialCount = vi.fn();
        const initialize = new InitializeSessionMetrics(
            { countSessionsForMaintenance: vi.fn().mockRejectedValue(error) },
            { listForMaintenance: async () => [{ tenantId: "a" }] },
            { recordInitialCount },
        );
        await expect(initialize.execute()).rejects.toBe(error);
        expect(recordInitialCount).not.toHaveBeenCalled();
    });
});
