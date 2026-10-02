import type { SessionData } from "./session-data.js";
import { isTerminalStatus, SessionStatus } from "./session-state.js";

/**
 * A wallet tried to redeem a session (offer or presentation request) that is
 * past its expiry or already in a terminal status.
 */
export class SessionNotUsable extends Error {
    constructor(
        /** `expired` once `expiresAt` passed, otherwise the terminal status. */
        readonly reason: SessionStatus,
    ) {
        super(
            reason === SessionStatus.Expired
                ? "The session has expired"
                : `The session is already ${reason}`,
        );
        this.name = "SessionNotUsable";
    }
}

/**
 * Wallet-facing entry points that redeem an offer or a presentation request
 * call this at request time, independent of the maintenance job that only
 * marks overdue sessions as expired periodically.
 * @throws SessionNotUsable when the session is terminal or `expiresAt` <= `now`
 */
export function assertSessionUsable(
    session: Pick<SessionData, "status" | "expiresAt">,
    now: Date,
): void {
    if (isTerminalStatus(session.status)) {
        throw new SessionNotUsable(session.status);
    }
    if (
        session.expiresAt &&
        new Date(session.expiresAt).getTime() <= now.getTime()
    ) {
        throw new SessionNotUsable(SessionStatus.Expired);
    }
}
