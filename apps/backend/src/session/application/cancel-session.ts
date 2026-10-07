import type { SessionData } from "../domain/session-data.js";
import type { SessionType } from "../domain/session-list.js";
import {
    isTerminalStatus,
    SessionStatus,
    stateUpdate,
} from "../domain/session-state.js";
import type { SessionCancellationPublisher } from "../ports/session-event-publisher.js";
import type { ChangeSessionState } from "./change-session-state.js";
import type { SessionStore } from "./session-store.js";

/**
 * Why a session can no longer be cancelled: its terminal status, or
 * `redeemed` once a wallet exchanged the offer for tokens.
 */
export type NotCancellableReason = SessionStatus | "redeemed";

/** The session already finished, expired, was redeemed or cancelled (HTTP 409). */
export class SessionNotCancellable extends Error {
    constructor(readonly reason: NotCancellableReason) {
        super(
            reason === "redeemed"
                ? "A wallet already redeemed the offer, so it can no longer be cancelled"
                : reason === SessionStatus.Expired
                  ? "The session has expired and can no longer be cancelled"
                  : `The session is already ${reason} and can no longer be cancelled`,
        );
        this.name = "SessionNotCancellable";
    }
}

/**
 * Why the cancellation of `session` did not match: a terminal status first,
 * then a redeemed offer; an open, unredeemed session is past its expiry.
 */
export function notCancellableReason(
    session: Pick<SessionData, "status" | "consumed">,
): NotCancellableReason {
    if (isTerminalStatus(session.status)) return session.status;
    if (session.consumed) return "redeemed";
    return SessionStatus.Expired;
}

/** Who cancelled the session, recorded in the tenant audit log. */
export interface CancellationActor {
    type: "user" | "client" | "system";
    id?: string;
    display?: string;
}

/** Transport metadata of the cancel request, e.g. the request ID. */
interface CancellationRequestMeta {
    requestId?: string;
}

export interface CancelSessionCommand {
    tenantId: string;
    sessionId: string;
    /** The only session type the caller may access, see `sessionScope`. */
    scope?: SessionType;
    /** Why the offer was cancelled, stored in the logs and sent to the webhook. */
    reason?: string;
    /** The client or user that cancelled the session. */
    actor: CancellationActor;
    requestMeta?: CancellationRequestMeta;
}

/** Records the cancellation in the audit logs. */
export type SessionCancellationLog = (
    session: { sessionId: string; tenantId: string },
    detail: {
        reason?: string;
        actor: CancellationActor;
        requestMeta?: CancellationRequestMeta;
    },
) => Promise<void>;

/**
 * Cancels a pending issuance offer or presentation request, so a wallet can no
 * longer use it to start a flow. The session is kept for auditing. Once a
 * wallet redeemed the offer (token exchange) or finished the presentation, the
 * session can no longer be cancelled; credentials already issued are revoked
 * with `POST /session/revoke` instead.
 */
export class CancelSession {
    constructor(
        private readonly sessions: Pick<
            SessionStore,
            "getForTenant" | "updateIfUnconsumed"
        >,
        private readonly state: Pick<ChangeSessionState, "announce">,
        private readonly events: SessionCancellationPublisher,
        private readonly log: SessionCancellationLog,
    ) {}

    /**
     * @throws SessionNotFound when the session does not exist or is outside the scope
     * @throws SessionNotCancellable when the session is redeemed, expired or no longer open
     */
    async execute(command: CancelSessionCommand): Promise<void> {
        const session = await this.sessions.getForTenant(
            command.tenantId,
            command.sessionId,
            command.scope,
        );

        // The same conditional update as the token exchange and the
        // presentation response (open, not consumed, not expired), so exactly
        // one of a cancellation and a concurrent redemption wins.
        const cancelled = await this.sessions.updateIfUnconsumed(
            session.tenantId,
            session.id,
            stateUpdate(SessionStatus.Cancelled),
        );
        if (!cancelled) {
            const current = await this.sessions.getForTenant(
                command.tenantId,
                command.sessionId,
                command.scope,
            );
            throw new SessionNotCancellable(notCancellableReason(current));
        }

        this.state.announce(session, SessionStatus.Cancelled);
        this.events.publishCancelled({
            sessionId: session.id,
            tenantId: session.tenantId,
            reason: command.reason,
        });
        await this.log(
            { sessionId: session.id, tenantId: session.tenantId },
            {
                reason: command.reason,
                actor: command.actor,
                requestMeta: command.requestMeta,
            },
        );
    }
}
