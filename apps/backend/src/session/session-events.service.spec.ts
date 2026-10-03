import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionNotFound } from "./application/session-errors.js";
import { SessionStatus } from "./domain/session-state.js";
import {
    SESSION_EVENTS_POLL_INTERVAL_MS,
    SessionEventsService,
} from "./session-events.service.js";

describe("SessionEventsService", () => {
    const updatedAt = new Date("2026-10-01T10:00:00.000Z");
    let getForTenant: ReturnType<typeof vi.fn>;
    let service: SessionEventsService;

    /** Subscribes and records the statuses and the completion. */
    function subscribe(sessionId = "session-1") {
        const statuses: string[] = [];
        const messages: unknown[] = [];
        let completed = false;
        const subscription = service
            .getSessionEvents("tenant-1", sessionId)
            .subscribe({
                next: (message) => {
                    const data = JSON.parse(message.data);
                    messages.push(data);
                    statuses.push(data.status);
                },
                complete: () => {
                    completed = true;
                },
            });
        return {
            statuses,
            messages,
            subscription,
            isCompleted: () => completed,
        };
    }

    function stored(status: SessionStatus) {
        getForTenant.mockResolvedValue({ id: "session-1", status, updatedAt });
    }

    function live(status: SessionStatus, sessionId = "session-1") {
        service.handleSessionStatusChanged({
            sessionId,
            status,
            updatedAt,
        });
    }

    beforeEach(() => {
        vi.useFakeTimers();
        getForTenant = vi.fn();
        service = new SessionEventsService({ getForTenant } as never);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts with the stored status, read for the subscriber's tenant", async () => {
        stored(SessionStatus.Active);

        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(0);

        expect(getForTenant).toHaveBeenCalledWith("tenant-1", "session-1");
        expect(stream.messages).toEqual([
            {
                id: "session-1",
                status: "active",
                updatedAt: "2026-10-01T10:00:00.000Z",
            },
        ]);
        expect(stream.isCompleted()).toBe(false);
        stream.subscription.unsubscribe();
    });

    it("emits in-process events once and completes after a terminal status", async () => {
        stored(SessionStatus.Active);
        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(0);

        live(SessionStatus.Fetched);
        live(SessionStatus.Fetched, "other-session");
        stored(SessionStatus.Fetched);
        await vi.advanceTimersByTimeAsync(SESSION_EVENTS_POLL_INTERVAL_MS);
        live(SessionStatus.Completed);

        expect(stream.statuses).toEqual(["active", "fetched", "completed"]);
        expect(stream.isCompleted()).toBe(true);
    });

    it.each([
        SessionStatus.Completed,
        SessionStatus.Failed,
        SessionStatus.Expired,
    ])(
        "delivers a %s status written by another replica via the database",
        async (status) => {
            stored(SessionStatus.Active);
            const stream = subscribe();
            await vi.advanceTimersByTimeAsync(0);

            stored(status);
            await vi.advanceTimersByTimeAsync(SESSION_EVENTS_POLL_INTERVAL_MS);

            expect(stream.statuses).toEqual(["active", status]);
            expect(stream.isCompleted()).toBe(true);
        },
    );

    it("completes at once for a session that already ended", async () => {
        stored(SessionStatus.Failed);

        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(0);

        expect(stream.statuses).toEqual(["failed"]);
        expect(stream.isCompleted()).toBe(true);
    });

    it("drops a stale read that resolves after a newer live event", async () => {
        let resolveRead: (value: unknown) => void = () => undefined;
        getForTenant.mockReturnValue(
            new Promise((resolve) => {
                resolveRead = resolve;
            }),
        );
        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(0);

        live(SessionStatus.Fetched);
        resolveRead({ status: SessionStatus.Active, updatedAt });
        await vi.advanceTimersByTimeAsync(0);

        expect(stream.statuses).toEqual(["fetched"]);
        stream.subscription.unsubscribe();
    });

    it("stops reading the database after unsubscribe", async () => {
        stored(SessionStatus.Active);
        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(SESSION_EVENTS_POLL_INTERVAL_MS);
        const reads = getForTenant.mock.calls.length;

        stream.subscription.unsubscribe();
        await vi.advanceTimersByTimeAsync(SESSION_EVENTS_POLL_INTERVAL_MS * 5);

        expect(getForTenant).toHaveBeenCalledTimes(reads);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops reading the database after completion", async () => {
        stored(SessionStatus.Active);
        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(0);

        live(SessionStatus.Completed);
        const reads = getForTenant.mock.calls.length;
        await vi.advanceTimersByTimeAsync(SESSION_EVENTS_POLL_INTERVAL_MS * 5);

        expect(stream.isCompleted()).toBe(true);
        expect(getForTenant).toHaveBeenCalledTimes(reads);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("ends the stream when the session no longer exists", async () => {
        getForTenant.mockRejectedValue(new SessionNotFound());

        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(0);

        expect(stream.statuses).toEqual([]);
        expect(stream.isCompleted()).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("skips a failed read and keeps polling", async () => {
        getForTenant.mockRejectedValueOnce(new Error("database unavailable"));
        const stream = subscribe();
        await vi.advanceTimersByTimeAsync(0);
        expect(stream.statuses).toEqual([]);

        stored(SessionStatus.Active);
        await vi.advanceTimersByTimeAsync(SESSION_EVENTS_POLL_INTERVAL_MS);

        expect(stream.statuses).toEqual(["active"]);
        expect(stream.isCompleted()).toBe(false);
        stream.subscription.unsubscribe();
    });
});
