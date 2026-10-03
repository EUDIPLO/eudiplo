import { describe, expect, it, vi } from "vitest";
import type { NewSession, SessionData } from "../domain/session-data.js";
import { CreateSession } from "./create-session.js";

describe("CreateSession", () => {
    it("returns the persisted session", async () => {
        const created = {
            id: "session-1",
            tenantId: "tenant-1",
        } as SessionData;
        const create = vi.fn().mockResolvedValue(created);
        const useCase = new CreateSession({ create });
        const input = { id: "session-1", tenantId: "tenant-1" } as NewSession;

        await expect(useCase.execute(input)).resolves.toBe(created);
        expect(create).toHaveBeenCalledExactlyOnceWith(input);
    });

    it("binds the created session to the request context", async () => {
        const created = {
            id: "session-1",
            tenantId: "tenant-1",
        } as SessionData;
        const context = { bind: vi.fn() };
        const useCase = new CreateSession(
            { create: vi.fn().mockResolvedValue(created) },
            context,
        );

        await useCase.execute({ id: "session-1", tenantId: "tenant-1" });

        expect(context.bind).toHaveBeenCalledExactlyOnceWith(created);
    });

    it("propagates persistence failures", async () => {
        const failure = new Error("database unavailable");
        const useCase = new CreateSession({
            create: vi.fn().mockRejectedValue(failure),
        });

        await expect(
            useCase.execute({
                id: "session-1",
                tenantId: "tenant-1",
            } as NewSession),
        ).rejects.toBe(failure);
    });
});
