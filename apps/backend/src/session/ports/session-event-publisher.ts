import type { SessionStatus } from "../domain/session-state.js";

export const SESSION_EVENT_PUBLISHER = Symbol("SESSION_EVENT_PUBLISHER");
export const SESSION_STATUS_CHANGED = "session.status.changed";

export interface SessionStatusChangedEvent {
    sessionId: string;
    status: SessionStatus;
    updatedAt: Date;
}

export interface SessionEventPublisher {
    publishStatusChanged(event: SessionStatusChangedEvent): void;
}

export const SESSION_CANCELLATION_PUBLISHER = Symbol(
    "SESSION_CANCELLATION_PUBLISHER",
);
export const SESSION_CANCELLED = "session.cancelled";

/** An operator cancelled a pending session, published after it was persisted. */
export interface SessionCancelledEvent {
    sessionId: string;
    tenantId: string;
    reason?: string;
}

export interface SessionCancellationPublisher {
    publishCancelled(event: SessionCancelledEvent): void;
}
