import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../domain/session-data.js";
import { GetSessionForTenant } from "./get-session-for-tenant.js";
import { SessionNotFound } from "./session-errors.js";

describe("GetSessionForTenant", () => {
    it("returns the session from the tenant-scoped repository lookup", async () => {
        const session = {
            id: "session-1",
            tenantId: "tenant-1",
        } as SessionData;
        const findForTenant = vi.fn().mockResolvedValue(session);
        const useCase = new GetSessionForTenant({ findForTenant });

        await expect(useCase.execute("tenant-1", "session-1")).resolves.toBe(
            session,
        );
        expect(findForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
        );
    });

    it("does not query without a session ID", async () => {
        const findForTenant = vi.fn();
        const useCase = new GetSessionForTenant({ findForTenant });

        await expect(
            useCase.execute("tenant-1", undefined),
        ).rejects.toBeInstanceOf(SessionNotFound);
        expect(findForTenant).not.toHaveBeenCalled();
    });

    it("maps a missing tenant-scoped session and preserves repository failures", async () => {
        const findForTenant = vi.fn().mockResolvedValue(null);
        const useCase = new GetSessionForTenant({ findForTenant });
        await expect(
            useCase.execute("tenant-1", "session-1"),
        ).rejects.toBeInstanceOf(SessionNotFound);

        const failure = new Error("database unavailable");
        findForTenant.mockRejectedValue(failure);
        await expect(useCase.execute("tenant-1", "session-1")).rejects.toBe(
            failure,
        );
    });
});
