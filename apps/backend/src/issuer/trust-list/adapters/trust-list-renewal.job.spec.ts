import type { SchedulerRegistry } from "@nestjs/schedule";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRUST_LIST_RENEWAL_CHECK_INTERVAL_MS } from "../domain/trust-list-validity.js";
import type { TrustListService } from "../trustlist.service.js";
import { TrustListRenewalJob } from "./trust-list-renewal.job.js";

describe("TrustListRenewalJob", () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("renews due lists at startup and on every interval", async () => {
        vi.useFakeTimers();
        const addInterval = vi.fn();
        const renewDueTrustLists = vi.fn().mockResolvedValue(0);
        const job = new TrustListRenewalJob(
            { addInterval } as unknown as SchedulerRegistry,
            { renewDueTrustLists } as unknown as TrustListService,
        );

        await job.onApplicationBootstrap();
        expect(addInterval).toHaveBeenCalledWith(
            "renewTrustLists",
            expect.anything(),
        );
        expect(renewDueTrustLists).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(TRUST_LIST_RENEWAL_CHECK_INTERVAL_MS);
        expect(renewDueTrustLists).toHaveBeenCalledTimes(2);
    });

    it("does not fail startup when renewal fails", async () => {
        vi.useFakeTimers();
        const job = new TrustListRenewalJob(
            { addInterval: vi.fn() } as unknown as SchedulerRegistry,
            {
                renewDueTrustLists: vi
                    .fn()
                    .mockRejectedValue(new Error("database unavailable")),
            } as unknown as TrustListService,
        );

        await expect(job.onApplicationBootstrap()).resolves.toBeUndefined();
    });
});
