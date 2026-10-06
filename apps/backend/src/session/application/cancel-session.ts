import type { SessionType } from "../domain/session-list.js";
import {
    OPEN_SESSION_STATUSES,
    SessionStatus,
} from "../domain/session-state.js";
import type { SessionCancellationPublisher } from "../ports/session-event-publisher.js";
import type { ChangeSessionState } from "./change-session-state.js";
import type { SessionStore } from "./session-store.js";

/** The session already finished, expired or was cancelled (HTTP 409). */
export class SessionNotCancellable extends Error {
    constructor(readonly status: SessionStatus) {
        super(
            status === SessionStatus.Expired
                ? "The session has expired and can no longer be cancelled"
                : `The session is already ${status} and can no longer be cancelled`,
        );
        this.name = "SessionNotCancellable";
    }
}

export interface CancelSessionCommand {
    tenantId: string;
    sessionId: string;
    /** The only session type the caller may access, see `sessionScope`. */
    scope?: SessionType;
    /** Why the offer was cancelled, stored in the session log. */
    reason?: string;
    /** The client or user that cancelled the session. */
    actor?: string;
}

/** Records the cancellation in the session's audit log. */
export type SessionCancellationLog = (
    session: { sessionId: string; tenantId: string },
    detail: { reason?: string; actor?: string },
) => void;

/**
 * Cancels a pending issuance offer or presentation request, so a wallet can no
 * longer use it to start a flow. The session is kept for auditing. A flow the
 * wallet already started (e.g. a credential request with an issued access
 * token) is not interrupted.
 */
export class CancelSession {
    constructor(
        private readonly sessions: Pick<SessionStore, "getForTenant">,
        private readonly state: Pick<ChangeSessionState, "executeFrom">,
        private readonly events: SessionCancellationPublisher,
        private readonly log: SessionCancellationLog,
    ) {}

    /**
     * @throws SessionNotFound when the session does not exist or is outside the scope
     * @throws SessionNotCancellable when the session is no longer open
     */
    async execute(command: CancelSessionCommand): Promise<void> {
        const session = await this.sessions.getForTenant(
            command.tenantId,
            command.sessionId,
            command.scope,
        );
        if (
            session.expiresAt &&
            new Date(session.expiresAt).getTime() <= Date.now()
        ) {
            throw new SessionNotCancellable(SessionStatus.Expired);
        }

        // Compare-and-set: exactly one of a cancellation and a concurrent
        // redemption or second cancellation wins.
        const cancelled = await this.state.executeFrom(
            session,
            OPEN_SESSION_STATUSES,
            SessionStatus.Cancelled,
        );
        if (!cancelled) {
            const current = await this.sessions.getForTenant(
                command.tenantId,
                command.sessionId,
                command.scope,
            );
            throw new SessionNotCancellable(current.status);
        }

        this.log(
            { sessionId: session.id, tenantId: session.tenantId },
            { reason: command.reason, actor: command.actor },
        );
        this.events.publishCancelled({
            sessionId: session.id,
            tenantId: session.tenantId,
            reason: command.reason,
        });
    }
}
