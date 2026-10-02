import {
    type SessionLifecycleContext,
    type SessionStatus,
    stateUpdate,
} from "../domain/session-state.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionEventPublisher } from "../ports/session-event-publisher.js";

export class ChangeSessionState {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "changeState" | "changeStateFrom"
        >,
        private readonly events: SessionEventPublisher,
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
     * Changes the status only while the session is still in one of `from`
     * (compare-and-set) and announces the transition only when this call
     * changed it, so repeated or concurrent requests publish it once.
     * @returns whether this call changed the status
     */
    async executeFrom(
        session: SessionLifecycleContext,
        from: readonly SessionStatus[],
        status: SessionStatus,
    ): Promise<boolean> {
        const changed = await this.sessions.changeStateFrom(
            session.tenantId,
            session.id,
            from,
            stateUpdate(status),
        );
        if (changed) this.announce(session, status);
        return changed;
    }

    /**
     * Publishes the status event for a transition the caller already
     * persisted in its own write (e.g. an atomic single-use completion). Call
     * it once, and only after that write took effect.
     */
    announce(session: SessionLifecycleContext, status: SessionStatus): void {
        this.events.publishStatusChanged({
            sessionId: session.id,
            status,
            updatedAt: new Date(),
        });
    }
}
