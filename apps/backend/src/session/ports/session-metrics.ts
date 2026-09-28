import type {
    SessionLifecycleContext,
    SessionStatus,
} from "../domain/session-state.js";

export const SESSION_METRICS = Symbol("SESSION_METRICS");
export interface SessionMetrics {
    recordCreated(session: SessionLifecycleContext): void;
    recordStateChange(
        session: SessionLifecycleContext,
        status: SessionStatus,
    ): void;
    recordInitialCount(
        tenantId: string,
        kind: "issuance" | "verification",
        status: SessionStatus,
        count: number,
    ): void;
}
