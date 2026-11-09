import { describe, expect, it, vi } from "vitest";
import { WalletUnitStatusCheckJob } from "./wallet-unit-status-check.job.js";

function setup(intervalSeconds: number, execute = vi.fn(async () => {})) {
    const scheduler = { addInterval: vi.fn() };
    const job = new WalletUnitStatusCheckJob(
        scheduler as never,
        { execute } as never,
        { intervalSeconds },
    );
    return { job, scheduler, execute };
}

describe("WalletUnitStatusCheckJob", () => {
    it("does not schedule or run the check when the interval is 0", () => {
        const { job, scheduler, execute } = setup(0);

        job.onApplicationBootstrap();

        expect(scheduler.addInterval).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
    });

    it("schedules the check and runs it once after startup", () => {
        vi.useFakeTimers();
        try {
            const { job, scheduler, execute } = setup(60);

            job.onApplicationBootstrap();

            expect(scheduler.addInterval).toHaveBeenCalledWith(
                "checkWalletUnitStatus",
                expect.anything(),
            );
            expect(execute).toHaveBeenCalledOnce();
            clearInterval(scheduler.addInterval.mock.calls[0][1]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("runs a requested check after the running one and never overlaps", async () => {
        let finishFirst!: () => void;
        const execute = vi
            .fn()
            .mockImplementationOnce(
                () => new Promise<void>((resolve) => (finishFirst = resolve)),
            )
            .mockResolvedValue(undefined);
        const { job } = setup(60, execute);

        const first = job.run();
        const second = job.run();
        const third = job.run();
        expect(execute).toHaveBeenCalledOnce();

        finishFirst();
        await Promise.all([first, second, third]);
        expect(execute).toHaveBeenCalledTimes(2);
        expect(second).toBe(third);
    });

    it("logs a failed check instead of rejecting", async () => {
        const { job } = setup(
            60,
            vi.fn(async () => {
                throw new Error("db down");
            }),
        );

        await expect(job.run()).resolves.toBeUndefined();
    });
});
