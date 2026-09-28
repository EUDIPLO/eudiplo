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
