import {
    type SessionLifecycleContext,
    type SessionStatus,
    stateUpdate,
} from "../domain/session-state.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionEventPublisher } from "../ports/session-event-publisher.js";
import type { SessionMetrics } from "../ports/session-metrics.js";

export class ChangeSessionState {
    constructor(
        private readonly sessions: Pick<SessionRepository, "changeState">,
        private readonly events: SessionEventPublisher,
        private readonly metrics: Pick<SessionMetrics, "recordStateChange">,
    ) {}

    async execute(
        session: SessionLifecycleContext,
        status: SessionStatus,
    ): Promise<void> {
        await this.sessions.changeState(
            session.tenantId,
            session.id,
            stateUpdate(status),
        );
        this.announce(session, status);
    }

    /**
     * Publishes the status event and records metrics for a transition the
     * caller already persisted in its own write (e.g. an atomic single-use
     * completion). Call it once, and only after that write took effect.
     */
    announce(session: SessionLifecycleContext, status: SessionStatus): void {
        // Keep the existing persistence -> synchronous event -> metrics order.
        this.events.publishStatusChanged({
            sessionId: session.id,
            status,
            updatedAt: new Date(),
        });
        this.metrics.recordStateChange(session, status);
    }
}
