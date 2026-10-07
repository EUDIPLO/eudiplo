import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../domain/session-data.js";
import { SessionStatus } from "../domain/session-state.js";
import {
    CancelSession,
    notCancellableReason,
    SessionNotCancellable,
} from "./cancel-session.js";
import { SessionNotFound } from "./session-errors.js";

function setup(
    session: Partial<SessionData> = { status: SessionStatus.Active },
    cancelled = true,
) {
    const stored = { id: "session-1", tenantId: "tenant-1", ...session };
    const sessions = {
        getForTenant: vi.fn().mockResolvedValue(stored),
        updateIfUnconsumed: vi.fn().mockResolvedValue(cancelled),
    };
    const state = { announce: vi.fn() };
    const events = { publishCancelled: vi.fn() };
    const log = vi.fn().mockResolvedValue(undefined);
    return {
        sessions,
        state,
        events,
        log,
        useCase: new CancelSession(sessions as never, state, events, log),
    };
}

const actor = { type: "client" as const, id: "client-1", display: "client-1" };
const command = {
    tenantId: "tenant-1",
    sessionId: "session-1",
    reason: "sent to wrong recipient",
    actor,
    requestMeta: { requestId: "request-1" },
};

describe("CancelSession", () => {
    it("cancels with the single-use update, then announces and logs it", async () => {
        const { useCase, sessions, state, log, events } = setup();

        await useCase.execute({ ...command, scope: "issuance" });

        expect(sessions.updateIfUnconsumed).toHaveBeenCalledWith(
            "tenant-1",
            "session-1",
            {
                status: SessionStatus.Cancelled,
                responseEncryptionPrivateJwk: null,
            },
        );
        expect(state.announce).toHaveBeenCalledWith(
            expect.objectContaining({ id: "session-1" }),
            SessionStatus.Cancelled,
        );
        expect(events.publishCancelled).toHaveBeenCalledWith({
            sessionId: "session-1",
            tenantId: "tenant-1",
            reason: "sent to wrong recipient",
        });
        expect(log).toHaveBeenCalledWith(
            { sessionId: "session-1", tenantId: "tenant-1" },
            {
                reason: "sent to wrong recipient",
                actor,
                requestMeta: { requestId: "request-1" },
            },
        );
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
        const { useCase, sessions } = setup();
        sessions.getForTenant.mockRejectedValue(new SessionNotFound());

        await expect(useCase.execute(command)).rejects.toBeInstanceOf(
            SessionNotFound,
        );
        expect(sessions.updateIfUnconsumed).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "completed",
            session: { status: SessionStatus.Completed },
            reason: SessionStatus.Completed,
        },
        {
            name: "cancelled",
            session: { status: SessionStatus.Cancelled },
            reason: SessionStatus.Cancelled,
        },
        {
            name: "redeemed",
            session: { status: SessionStatus.Active, consumed: true },
            reason: "redeemed",
        },
        {
            name: "overdue",
            session: {
                status: SessionStatus.Active,
                expiresAt: new Date(Date.now() - 1000),
            },
            reason: SessionStatus.Expired,
        },
    ])(
        "rejects a $name session without announcing or logging it",
        async ({ session, reason }) => {
            const { useCase, state, log, events } = setup(session, false);

            const error = await useCase.execute(command).catch((e) => e);

            expect(error).toBeInstanceOf(SessionNotCancellable);
            expect(error.reason).toBe(reason);
            expect(state.announce).not.toHaveBeenCalled();
            expect(events.publishCancelled).not.toHaveBeenCalled();
            expect(log).not.toHaveBeenCalled();
        },
    );

    it("reports the state that won when a concurrent request changed the session first", async () => {
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
                status: SessionStatus.Active,
                consumed: true,
            });

        await expect(useCase.execute(command)).rejects.toMatchObject({
            reason: "redeemed",
            message:
                "A wallet already redeemed the offer, so it can no longer be cancelled",
        });
    });
});

describe("notCancellableReason", () => {
    it("prefers the terminal status over the consumed flag", () => {
        expect(
            notCancellableReason({
                status: SessionStatus.Completed,
                consumed: true,
            }),
        ).toBe(SessionStatus.Completed);
    });

    it("names an open, unredeemed session expired", () => {
        expect(
            notCancellableReason({
                status: SessionStatus.Fetched,
                consumed: false,
            }),
        ).toBe(SessionStatus.Expired);
    });
});
