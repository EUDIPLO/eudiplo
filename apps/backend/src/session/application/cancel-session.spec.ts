import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../domain/session-data.js";
import {
    OPEN_SESSION_STATUSES,
    SessionStatus,
} from "../domain/session-state.js";
import { CancelSession, SessionNotCancellable } from "./cancel-session.js";
import { SessionNotFound } from "./session-errors.js";

function setup(
    session: Partial<SessionData> = { status: SessionStatus.Active },
    cancelled = true,
) {
    const stored = { id: "session-1", tenantId: "tenant-1", ...session };
    const sessions = {
        getForTenant: vi.fn().mockResolvedValue(stored),
    };
    const state = { executeFrom: vi.fn().mockResolvedValue(cancelled) };
    const events = { publishCancelled: vi.fn() };
    const log = vi.fn();
    return {
        sessions,
        state,
        events,
        log,
        useCase: new CancelSession(sessions as never, state, events, log),
    };
}

const command = {
    tenantId: "tenant-1",
    sessionId: "session-1",
    reason: "sent to wrong recipient",
    actor: "client-1",
};

describe("CancelSession", () => {
    it("cancels an open session with a compare-and-set, then logs and announces it", async () => {
        const { useCase, state, log, events } = setup();

        await useCase.execute({ ...command, scope: "issuance" });

        expect(state.executeFrom).toHaveBeenCalledWith(
            expect.objectContaining({ id: "session-1" }),
            OPEN_SESSION_STATUSES,
            SessionStatus.Cancelled,
        );
        expect(log).toHaveBeenCalledWith(
            { sessionId: "session-1", tenantId: "tenant-1" },
            { reason: "sent to wrong recipient", actor: "client-1" },
        );
        expect(events.publishCancelled).toHaveBeenCalledWith({
            sessionId: "session-1",
            tenantId: "tenant-1",
            reason: "sent to wrong recipient",
        });
    });

    it("looks the session up within the caller's scope", async () => {
        const { useCase, sessions } = setup();

        await useCase.execute({ ...command, scope: "presentation" });

        expect(sessions.getForTenant).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
            "presentation",
        );
    });

    it("passes a missing session on as SessionNotFound", async () => {
        const { useCase, sessions, state } = setup();
        sessions.getForTenant.mockRejectedValue(new SessionNotFound());

        await expect(useCase.execute(command)).rejects.toBeInstanceOf(
            SessionNotFound,
        );
        expect(state.executeFrom).not.toHaveBeenCalled();
    });

    it("rejects a session past its expiry without changing it", async () => {
        const { useCase, state, events } = setup({
            status: SessionStatus.Active,
            expiresAt: new Date(Date.now() - 1000),
        });

        await expect(useCase.execute(command)).rejects.toMatchObject({
            status: SessionStatus.Expired,
        });
        expect(state.executeFrom).not.toHaveBeenCalled();
        expect(events.publishCancelled).not.toHaveBeenCalled();
    });

    it.each([
        SessionStatus.Completed,
        SessionStatus.Failed,
        SessionStatus.Expired,
        SessionStatus.Cancelled,
    ])(
        "rejects a %s session without logging or announcing it",
        async (status) => {
            const { useCase, log, events } = setup({ status }, false);

            const error = await useCase.execute(command).catch((e) => e);

            expect(error).toBeInstanceOf(SessionNotCancellable);
            expect(error.status).toBe(status);
            expect(log).not.toHaveBeenCalled();
            expect(events.publishCancelled).not.toHaveBeenCalled();
        },
    );

    it("reports the status that won when a concurrent request finished the session first", async () => {
        const { useCase, sessions } = setup(
            { status: SessionStatus.Active },
            false,
        );
        sessions.getForTenant
            .mockResolvedValueOnce({
                id: "session-1",
                tenantId: "tenant-1",
                status: SessionStatus.Active,
            })
            .mockResolvedValueOnce({
                id: "session-1",
                tenantId: "tenant-1",
                status: SessionStatus.Completed,
            });

        await expect(useCase.execute(command)).rejects.toMatchObject({
            status: SessionStatus.Completed,
            message:
                "The session is already completed and can no longer be cancelled",
        });
    });
});
