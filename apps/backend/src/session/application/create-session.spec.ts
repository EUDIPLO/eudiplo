import { describe, expect, it, vi } from "vitest";
import type { NewSession, SessionData } from "../domain/session-data.js";
import { CreateSession } from "./create-session.js";

describe("CreateSession", () => {
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
});
