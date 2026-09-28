import { describe, expect, it, vi } from "vitest";
import type { NewSession, SessionData } from "../domain/session-data.js";
import { CreateSession } from "./create-session.js";
import { UpdateSessionForTenant } from "./update-session-for-tenant.js";

describe("session write use cases", () => {
    it("records creation metrics from the persisted session", async () => {
        const created = {
            id: "session-1",
            tenantId: "tenant-1",
        } as SessionData;
        const create = vi.fn().mockResolvedValue(created);
        const recordCreated = vi.fn();
        const useCase = new CreateSession({ create }, { recordCreated });

        await expect(
            useCase.execute({
                id: "session-1",
                tenantId: "tenant-1",
            } as NewSession),
        ).resolves.toBe(created);
        expect(recordCreated).toHaveBeenCalledExactlyOnceWith(created);
    });

    it("does not record creation metrics when persistence fails", async () => {
        const failure = new Error("database unavailable");
        const recordCreated = vi.fn();
        const useCase = new CreateSession(
            { create: vi.fn().mockRejectedValue(failure) },
            { recordCreated },
        );

        await expect(
            useCase.execute({
                id: "session-1",
                tenantId: "tenant-1",
            } as NewSession),
        ).rejects.toBe(failure);
        expect(recordCreated).not.toHaveBeenCalled();
    });

    it("forwards updates with explicit tenant scope and returns the affected-row count", async () => {
        const updateForTenant = vi.fn().mockResolvedValue(1);
        const useCase = new UpdateSessionForTenant({ updateForTenant });
        const update = { requestObject: "request" };

        await expect(
            useCase.execute("tenant-1", "session-1", update),
        ).resolves.toBe(1);
        expect(updateForTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            "session-1",
            update,
        );
    });
});
