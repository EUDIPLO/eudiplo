import { describe, expect, it } from "vitest";
import {
    isTerminalStatus,
    OPEN_SESSION_STATUSES,
    SessionStatus,
    stateUpdate,
} from "./session-state.js";
import { assertSessionUsable, SessionNotUsable } from "./session-usability.js";

const now = new Date("2026-03-01T12:00:00.000Z");

function rejection(session: Parameters<typeof assertSessionUsable>[0]) {
    try {
        assertSessionUsable(session, now);
    } catch (error) {
        return error;
    }
    return undefined;
}

describe("assertSessionUsable", () => {
    it.each([SessionStatus.Active, SessionStatus.Fetched])(
        "accepts a %s session without expiry",
        (status) => {
            expect(rejection({ status })).toBeUndefined();
        },
    );

    it("accepts a session up to, but not at, its expiry", () => {
        expect(
            rejection({
                status: SessionStatus.Active,
                expiresAt: new Date(now.getTime() + 1),
            }),
        ).toBeUndefined();
        const error = rejection({
            status: SessionStatus.Active,
            expiresAt: now,
        });
        expect(error).toBeInstanceOf(SessionNotUsable);
        expect(error).toMatchObject({
            reason: SessionStatus.Expired,
            message: "The session has expired",
        });
    });

    it.each([
        [SessionStatus.Completed, "The session is already completed"],
        [SessionStatus.Failed, "The session is already failed"],
        [SessionStatus.Expired, "The session has expired"],
        [SessionStatus.Cancelled, "The session is already cancelled"],
    ])("rejects a %s session even before its expiry", (status, message) => {
        const error = rejection({
            status,
            expiresAt: new Date(now.getTime() + 60_000),
        });
        expect(error).toBeInstanceOf(SessionNotUsable);
        expect(error).toMatchObject({ reason: status, message });
    });

    it("accepts an expiry stored as an ISO string", () => {
        expect(
            rejection({
                status: SessionStatus.Active,
                expiresAt: "2026-03-01T11:59:59.000Z" as unknown as Date,
            }),
        ).toBeInstanceOf(SessionNotUsable);
    });
});

describe("session status classification", () => {
    it("treats completed, failed, expired and cancelled as terminal", () => {
        expect(
            Object.values(SessionStatus).filter((status) =>
                isTerminalStatus(status),
            ),
        ).toEqual([
            SessionStatus.Completed,
            SessionStatus.Expired,
            SessionStatus.Failed,
            SessionStatus.Cancelled,
        ]);
        expect(OPEN_SESSION_STATUSES).toEqual([
            SessionStatus.Active,
            SessionStatus.Fetched,
        ]);
    });

    it("clears the response key on terminal transitions only", () => {
        expect(stateUpdate(SessionStatus.Fetched)).toEqual({
            status: SessionStatus.Fetched,
        });
        expect(stateUpdate(SessionStatus.Expired)).toEqual({
            status: SessionStatus.Expired,
            responseEncryptionPrivateJwk: null,
        });
    });
});
