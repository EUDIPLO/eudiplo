import type { SessionListQuery, SessionType } from "./session-list.js";
import { SessionStatus } from "./session-state.js";

/** Most frequent failure codes reported per session type. */
export const MAX_FAILURE_CODES = 10;

/** Failure codes are reported up to this length; wallets choose the codes of their errors. */
export const MAX_FAILURE_CODE_LENGTH = 255;

/** Sessions to count, by creation time as in the session list; bounds included. */
export type SessionStatsFilter = Pick<
    SessionListQuery,
    "createdFrom" | "createdTo"
>;

/** Sessions to count: the stats filter, optionally of one type only. */
export type SessionCountFilter = Pick<
    SessionListQuery,
    "createdFrom" | "createdTo" | "type" | "configLimits"
>;

/** Number of a tenant's sessions of one type in one status. */
export interface SessionTypeStatusCount {
    type: SessionType;
    status: SessionStatus;
    count: number;
}

/** Number of a tenant's failed sessions with one failure code. */
export interface SessionFailureCodeCount {
    code: string;
    count: number;
}

/** Counts of one session type; every status is present, empty ones as 0. */
export interface SessionTypeStats {
    total: number;
    byStatus: Record<SessionStatus, number>;
    /** Failure codes of failed sessions, most frequent first. */
    failureCodes: SessionFailureCodeCount[];
    /** Last update of the most recently updated completed session, or null. */
    lastCompletedAt: Date | null;
}

/** Holds only the session types the caller may access. */
export type SessionStats = Partial<Record<SessionType, SessionTypeStats>>;

/** `failureCodes` are the type's most frequent ones, already ordered and limited. */
export function sessionTypeStats(
    type: SessionType,
    counts: SessionTypeStatusCount[],
    failureCodes: SessionFailureCodeCount[],
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
    return { total, byStatus, failureCodes, lastCompletedAt };
}
