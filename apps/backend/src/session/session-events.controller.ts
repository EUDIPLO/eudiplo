import { Controller, Get, Logger, Param, Sse } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Observable } from "rxjs";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { SessionStore } from "./application/session-store.js";
import { SessionEventsService } from "./session-events.service.js";
import { sessionScope } from "./session-scope.js";

/**
 * Controller for Server-Sent Events (SSE) based session status updates.
 * Provides real-time session status notifications as an alternative to polling.
 *
 * The stream is a plain `GET` authorized like `GET /session/{id}`: a bearer
 * token in the `Authorization` header with the same roles and the same
 * session scope. Tokens in the URL are not accepted, so management tokens do
 * not end up in access logs. The browser's `EventSource` cannot send headers;
 * read the stream with `fetch` from a backend instead.
 *
 * @example
 * ```typescript
 * const response = await fetch(`${baseUrl}/api/session/${sessionId}/events`, {
 *   headers: { Authorization: `Bearer ${token}` },
 * });
 * for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
 *   console.log(chunk); // "data: {\"id\":\"…\",\"status\":\"active\",…}\n\n"
 * }
 * ```
 */
@ApiTags("Session Events")
@Secured([Role.IssuanceOffer, Role.PresentationRequest])
@Controller("session")
export class SessionEventsController {
    private readonly logger = new Logger(SessionEventsController.name);

    constructor(
        private readonly sessionEventsService: SessionEventsService,
        private readonly sessionStore: SessionStore,
    ) {}

    /**
     * Subscribe to real-time session status updates via Server-Sent Events.
     *
     * The stream starts with the current status and emits an event whenever
     * the session status changes:
     * - active: Session created, waiting for wallet interaction
     * - fetched: Credential offer/presentation request fetched by wallet
     * - completed: Session successfully completed
     * - expired: Session expired
     * - failed: Session failed
     *
     * After a terminal status (completed, expired, failed) the stream ends.
     * Changes processed by another backend instance arrive within a few
     * seconds.
     *
     * @param id - The session ID to subscribe to
     * @returns Observable stream of session status events
     */
    @Get(":id/events")
    @Sse()
    @ApiOperation({
        summary: "Subscribe to session status updates",
        description:
            "Server-Sent Events endpoint for real-time session status updates. " +
            "The first event carries the current status; the stream ends after " +
            "a terminal status (completed, expired, failed). " +
            "Authorized like GET /session/{id}: send the token in the Authorization header.",
    })
    @ApiParam({
        name: "id",
        description: "Session ID to subscribe to",
        type: String,
    })
    @ApiResponse({
        status: 200,
        description: "Server-Sent Events stream of session updates",
        content: {
            "text/event-stream": {
                schema: {
                    type: "string",
                    example:
                        'event: message\ndata: {"id":"session-1","status":"active","updatedAt":"2026-01-01T00:00:00.000Z"}\n\n',
                },
            },
        },
    })
    @ApiResponse({
        status: 404,
        description:
            "No session with this ID in the tenant, or a session of the other type than the client's roles cover",
    })
    async subscribeToSessionEvents(
        @Param("id") id: string,
        @Token() token: TokenPayload,
    ): Promise<Observable<MessageEvent>> {
        const tenantId = token.entity!.id;
        // Throws SessionNotFound (404) for unknown and out-of-scope sessions.
        const session = await this.sessionStore.getForTenant(
            tenantId,
            id,
            sessionScope(token),
        );
        this.logger.debug(`Client subscribed to session ${id} events`);

        // The stream starts with the current status itself.
        return this.sessionEventsService.getSessionEvents(tenantId, session.id);
    }
}
