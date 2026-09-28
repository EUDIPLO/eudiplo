import { SchedulerRegistry } from "@nestjs/schedule";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CleanupSessions } from "../application/cleanup-sessions.js";
import type { InitializeSessionMetrics } from "../application/initialize-session-metrics.js";
import { SessionMaintenanceJob } from "./session-maintenance.job.js";

describe("SessionMaintenanceJob", () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });
    it("registers the same interval, initializes counts, then cleans up and repeats", async () => {
        vi.useFakeTimers();
        const order: string[] = [];
        const addInterval = vi.fn(() => {
            order.push("schedule");
        });
        const initialize = vi.fn(async () => {
            order.push("initialize");
        });
        const cleanup = vi.fn(async () => {
            order.push("cleanup");
        });
        const job = new SessionMaintenanceJob(
            { addInterval } as unknown as SchedulerRegistry,
            { execute: cleanup } as unknown as CleanupSessions,
            { execute: initialize } as unknown as InitializeSessionMetrics,
            { cleanupIntervalMs: 5000 },
        );
        await job.onApplicationBootstrap();
        expect(addInterval).toHaveBeenCalledWith(
            "tidyUpSessions",
            expect.anything(),
        );
        expect(order).toEqual(["schedule", "initialize", "cleanup"]);
        await vi.advanceTimersByTimeAsync(4999);
        expect(cleanup).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(cleanup).toHaveBeenCalledTimes(2);
        expect(initialize).toHaveBeenCalledOnce();
    });
});
