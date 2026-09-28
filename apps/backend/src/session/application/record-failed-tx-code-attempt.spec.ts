import { describe, expect, it, vi } from "vitest";
import {
    RecordFailedTxCodeAttempt,
    SessionAttemptTargetNotFound,
} from "./record-failed-tx-code-attempt.js";

describe("RecordFailedTxCodeAttempt", () => {
    it.each([
        [4, undefined, false],
        [5, undefined, true],
        [6, undefined, true],
        [1, 2, false],
        [2, 2, true],
    ])(
        "evaluates count %i with limit %s",
        async (failedAttempts, limit, locked) => {
            const sessions = {
                incrementFailedTxCodeAttempts: vi
                    .fn()
                    .mockResolvedValue(failedAttempts),
            };
            expect(
                await new RecordFailedTxCodeAttempt(sessions).execute(
                    "tenant-a",
                    "session-a",
                    limit,
                ),
            ).toEqual({ failedAttempts, locked });
            expect(
                sessions.incrementFailedTxCodeAttempts,
            ).toHaveBeenCalledExactlyOnceWith("tenant-a", "session-a");
        },
    );
    it("reports a missing target without treating it as a successful increment", async () => {
        const sessions = {
            incrementFailedTxCodeAttempts: vi.fn().mockResolvedValue(null),
        };
        await expect(
            new RecordFailedTxCodeAttempt(sessions).execute(
                "tenant-a",
                "missing",
            ),
        ).rejects.toBeInstanceOf(SessionAttemptTargetNotFound);
    });
    it("propagates persistence failures", async () => {
        const error = new Error("storage unavailable");
        const sessions = {
            incrementFailedTxCodeAttempts: vi.fn().mockRejectedValue(error),
        };
        await expect(
            new RecordFailedTxCodeAttempt(sessions).execute(
                "tenant-a",
                "session-a",
            ),
        ).rejects.toBe(error);
    });
});
