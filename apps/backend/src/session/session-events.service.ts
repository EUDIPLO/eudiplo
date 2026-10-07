import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
    catchError,
    defer,
    EMPTY,
    exhaustMap,
    filter,
    from,
    map,
    merge,
    Observable,
    of,
    Subject,
    takeWhile,
    timer,
} from "rxjs";
import { SessionNotFound } from "./application/session-errors.js";
import { SessionStore } from "./application/session-store.js";
import { SessionStatus } from "./domain/session-state.js";
import {
    SESSION_STATUS_CHANGED,
    type SessionStatusChangedEvent,
} from "./ports/session-event-publisher.js";

/**
 * How often an open stream re-reads the session status from the database.
 * Status events are published in-process only, so the poll delivers changes
 * another backend replica processed (and its terminal status) to this one.
 */
export const SESSION_EVENTS_POLL_INTERVAL_MS = 3_000;

/**
 * SSE message format sent to clients.
 */
interface SessionEventMessage {
    id: string;
    status: SessionStatus;
    updatedAt: string;
}

interface StatusSnapshot {
    status: SessionStatus;
    updatedAt: Date;
}

/**
 * Sessions only move forward (active → fetched → terminal); the rank lets the
 * stream drop a stale read that lost the race against a live event.
 */
const STATUS_RANK: Record<SessionStatus, number> = {
    [SessionStatus.Active]: 0,
    [SessionStatus.Fetched]: 1,
    [SessionStatus.Completed]: 2,
    [SessionStatus.Failed]: 2,
    [SessionStatus.Expired]: 2,
    [SessionStatus.Cancelled]: 2,
};

function isTerminal(status: SessionStatus): boolean {
    return STATUS_RANK[status] === STATUS_RANK[SessionStatus.Completed];
}

/**
 * Service for managing session events and SSE streams.
 * Provides real-time session status updates via Server-Sent Events.
 */
@Injectable()
export class SessionEventsService {
    private readonly logger = new Logger(SessionEventsService.name);
    private readonly eventSubject = new Subject<SessionStatusChangedEvent>();

    constructor(private readonly sessionStore: SessionStore) {}

    /**
     * Get an observable stream of events for a specific session.
     * Used by the SSE endpoint to stream updates to clients.
     *
     * The stream starts with the current status, merges in-process events
     * with a periodic database read (so changes made by other replicas
     * arrive too), emits each status once, and completes after a terminal
     * status (completed, failed, expired, cancelled) or when the session is gone.
     * Unsubscribing stops the database reads.
     *
     * @param tenantId - Tenant that owns the session; scopes every read
     * @param sessionId - The session ID to subscribe to
     */
    getSessionEvents(
        tenantId: string,
        sessionId: string,
    ): Observable<MessageEvent> {
        return defer(() => {
            let last: SessionStatus | undefined;

            // Subscribed first, so no event is lost while the first read runs.
            const live = this.eventSubject.pipe(
                filter((event) => event.sessionId === sessionId),
                map(
                    (event): StatusSnapshot => ({
                        status: event.status,
                        updatedAt: event.updatedAt,
                    }),
                ),
            );
            // Reads immediately (current status), then every interval;
            // exhaustMap skips a tick while a read is still running.
            const stored = timer(0, SESSION_EVENTS_POLL_INTERVAL_MS).pipe(
                exhaustMap(() => this.readStatus(tenantId, sessionId)),
            );

            return merge(live, stored).pipe(
                takeWhile((snapshot): snapshot is StatusSnapshot => !!snapshot),
                filter((snapshot) => {
                    if (
                        last !== undefined &&
                        STATUS_RANK[snapshot.status] <= STATUS_RANK[last]
                    ) {
                        return false;
                    }
                    last = snapshot.status;
                    return true;
                }),
                takeWhile((snapshot) => !isTerminal(snapshot.status), true),
                map((snapshot) => {
                    const data: SessionEventMessage = {
                        id: sessionId,
                        status: snapshot.status,
                        updatedAt: snapshot.updatedAt.toISOString(),
                    };

                    return new MessageEvent("message", {
                        data: JSON.stringify(data),
                    });
                }),
            );
        });
    }

    /**
     * Current status from the session store; `null` once the session no
     * longer exists (ends the stream). Other read errors skip this poll.
     */
    private readStatus(
        tenantId: string,
        sessionId: string,
    ): Observable<StatusSnapshot | null> {
        return from(this.sessionStore.getForTenant(tenantId, sessionId)).pipe(
            map((session): StatusSnapshot | null => ({
                status: session.status,
                updatedAt: session.updatedAt,
            })),
            catchError((error: unknown) => {
                if (error instanceof SessionNotFound) {
                    return of(null);
                }
                this.logger.warn(
                    `Reading the status of session ${sessionId} failed: ${(error as Error)?.message ?? error}`,
                );
                return EMPTY;
            }),
        );
    }

    /**
     * Internal event handler for session status changes.
     * Forwards events to the Subject for SSE subscribers.
     */
    @OnEvent(SESSION_STATUS_CHANGED)
    handleSessionStatusChanged(event: SessionStatusChangedEvent): void {
        this.logger.debug(
            `Session ${event.sessionId} status changed to ${event.status}`,
        );
        // Forward to Subject for SSE subscribers
        this.eventSubject.next(event);
    }
}
