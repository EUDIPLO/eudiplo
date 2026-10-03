import type { SchedulerRegistry } from "@nestjs/schedule";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainedAsSessionCleanupJob } from "./chained-as-session-cleanup.job.js";

describe("ChainedAsSessionCleanupJob", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function job(deleteExpired = vi.fn().mockResolvedValue(0)) {
        const intervals = new Map<string, NodeJS.Timeout>();
        const scheduler = {
            addInterval: vi.fn((name: string, ref: NodeJS.Timeout) =>
                intervals.set(name, ref),
            ),
        } as unknown as SchedulerRegistry;
        const cleanupJob = new ChainedAsSessionCleanupJob(
            scheduler,
            { deleteExpired },
            { cleanupIntervalMs: 60_000 },
        );
        return { cleanupJob, deleteExpired, intervals };
    }

    it("cleans up on bootstrap and on the configured interval", async () => {
        const { cleanupJob, deleteExpired, intervals } = job();

        await cleanupJob.onApplicationBootstrap();
        expect(intervals.has("tidyUpChainedAsSessions")).toBe(true);
        expect(deleteExpired).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(deleteExpired).toHaveBeenCalledTimes(2);
        expect(deleteExpired.mock.calls[1][0]).toBeInstanceOf(Date);

        clearInterval(intervals.get("tidyUpChainedAsSessions"));
    });

    it("keeps running when a cleanup fails", async () => {
        const { cleanupJob, deleteExpired, intervals } = job(
            vi.fn().mockRejectedValueOnce(new Error("db down")),
        );

        await expect(cleanupJob.onApplicationBootstrap()).resolves.toBe(
            undefined,
        );
        deleteExpired.mockResolvedValue(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(deleteExpired).toHaveBeenCalledTimes(2);

        clearInterval(intervals.get("tidyUpChainedAsSessions"));
    });
});
