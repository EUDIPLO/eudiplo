import type { SessionType } from "./session-list.js";
import { SessionStatus } from "./session-state.js";

/** Number of a tenant's sessions of one type in one status. */
export interface SessionTypeStatusCount {
    type: SessionType;
    status: SessionStatus;
    count: number;
}

/** Counts of one session type; every status is present, empty ones as 0. */
export interface SessionTypeStats {
    total: number;
    byStatus: Record<SessionStatus, number>;
    /** Last update of the most recently updated completed session, or null. */
    lastCompletedAt: Date | null;
}

/** Holds only the session types the caller may access. */
export type SessionStats = Partial<Record<SessionType, SessionTypeStats>>;

export function sessionTypeStats(
    type: SessionType,
    counts: SessionTypeStatusCount[],
    lastCompletedAt: Date | null,
): SessionTypeStats {
    const byStatus = Object.fromEntries(
        Object.values(SessionStatus).map((status) => [status, 0]),
    ) as Record<SessionStatus, number>;
    let total = 0;
    for (const count of counts) {
        // A stored value outside SessionStatus would break the sum of byStatus.
        if (count.type !== type || !Object.hasOwn(byStatus, count.status))
            continue;
        byStatus[count.status] += count.count;
        total += count.count;
    }
    return { total, byStatus, lastCompletedAt };
}
