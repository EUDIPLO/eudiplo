import { expect, test, vi } from "vitest";
import { OidcSignInCleanupJob } from "./oidc-sign-in-cleanup.job.js";

test("deletes expired sign-ins and survives a failure", async () => {
    const deleteExpired = vi
        .fn()
        .mockResolvedValueOnce(2)
        .mockRejectedValueOnce(new Error("database down"));
    const job = new OidcSignInCleanupJob({} as never, { deleteExpired });
    await job.cleanup();
    await expect(job.cleanup()).resolves.toBeUndefined();
    expect(deleteExpired).toHaveBeenCalledTimes(2);
    expect(deleteExpired.mock.calls[0][0]).toBeInstanceOf(Date);
});
