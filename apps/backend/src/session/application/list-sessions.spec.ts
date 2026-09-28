import { describe, expect, it, vi } from "vitest";
import { DeleteSession } from "./delete-session.js";
import { ListSessions } from "./list-sessions.js";

describe("tenant session management", () => {
    it.each([
        [0, 0],
        [25, 1],
        [26, 2],
    ])("computes pages for %i matching sessions", async (total, totalPages) => {
        const sessions = {
            listForTenant: vi.fn().mockResolvedValue({ items: [], total }),
        };
        const query = { page: 2, pageSize: 25 };
        expect(
            await new ListSessions(sessions).execute("tenant-a", query),
        ).toEqual({ items: [], total, page: 2, pageSize: 25, totalPages });
        expect(sessions.listForTenant).toHaveBeenCalledWith("tenant-a", query);
    });

    it("preserves tenant scope and propagates persistence failures", async () => {
        const error = new Error("database unavailable");
        const sessions = {
            deleteForTenant: vi.fn().mockRejectedValue(error),
            listForTenant: vi.fn().mockRejectedValue(error),
        };
        await expect(
            new DeleteSession(sessions).execute("tenant-a", "session-b"),
        ).rejects.toBe(error);
        expect(sessions.deleteForTenant).toHaveBeenCalledWith(
            "tenant-a",
            "session-b",
        );
        await expect(
            new ListSessions(sessions).execute("tenant-a", {
                page: 1,
                pageSize: 25,
            }),
        ).rejects.toBe(error);
    });
});
