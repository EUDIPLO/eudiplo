import {
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Query,
} from "@nestjs/common";
import {
    ApiBody,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import type { AuditLogRequestMeta } from "../audit-log/audit-log.service.js";
import {
    AuditMeta,
    resolveAuditActor,
} from "../audit-log/audit-log-context.util.js";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { CredentialStatusDto } from "../issuer/status-list/dto/credential-status.dto.js";
import { StatusUpdateDto } from "../issuer/status-list/dto/status-update.dto.js";
import { StatusListService } from "../issuer/status-list/status-list.service.js";
import { redactSecrets } from "../shared/utils/write-only-secrets.util.js";
import {
    CancelSession,
    SessionNotCancellable,
} from "./application/cancel-session.js";
import { SessionStore } from "./application/session-store.js";
import type { SessionData } from "./domain/session-data.js";
import { typeOfSession } from "./domain/session-list.js";
import {
    BEARER_FIELDS,
    readOnlySessionView,
} from "./domain/session-read-view.js";
import { CancelSessionDto } from "./dto/cancel-session.dto.js";
import { PaginatedSessionResponseDto } from "./dto/paginated-session-response.dto.js";
import { SessionLogEntryResponseDto } from "./dto/session-log-entry-response.dto.js";
import { SessionQueryDto } from "./dto/session-query.dto.js";
import { SessionStatsQueryDto } from "./dto/session-stats-query.dto.js";
import { SessionStatsResponseDto } from "./dto/session-stats-response.dto.js";
import { Session } from "./entities/session.entity.js";
import { SessionLogStoreService } from "./logging/session-log-store.service.js";
import { SessionReads } from "./session-reads.js";
import {
    credentialStatusScope,
    readOnlySessionTypes,
    sessionChangeScope,
    sessionReadScope,
} from "./session-scope.js";

/** How the session reads treat a client with only `sessions:read` for a type. */
const READ_ONLY_NOTE =
    "A client that reads sessions of a type through `sessions:read` but cannot cancel or delete them (that needs `issuance:offer` or `presentation:request`, and `issuance:offer` or `issuance:manage` for issuance sessions, `presentation:request` or `presentation:manage` for presentation sessions) does not get the sessions of that type that a wallet can still redeem or answer (open status, not consumed): they are left out of the list and answer 404, since their ID is enough to redeem or answer them.";

/** The fields `readOnlySessionView` leaves out, for the OpenAPI description. */
const OMITTED_FIELDS = [...BEARER_FIELDS, "credentialPayload.tx_code"]
    .map((field) => "`" + field + "`")
    .join(", ");

@ApiTags("Session")
@Secured([Role.IssuanceOffer, Role.PresentationRequest, Role.SessionsRead])
@Controller("session")
export class SessionController {
    constructor(
        private readonly sessions: SessionStore,
        private readonly statusListService: StatusListService,
        private readonly logStoreService: SessionLogStoreService,
        private readonly cancelSession: CancelSession,
        private readonly reads: SessionReads,
    ) {}

    /**
     * Retrieves a paginated list of sessions with optional filters.
     */
    @ApiOperation({
        summary: "Get sessions (paginated)",
        description: READ_ONLY_NOTE,
    })
    @ApiResponse({ status: 200, type: PaginatedSessionResponseDto })
    @Get()
    getAllSessions(
        @Token() token: TokenPayload,
        @Query() query: SessionQueryDto,
    ): Promise<PaginatedSessionResponseDto> {
        return this.reads.list(token.entity!.id, token, query);
    }

    /**
     * Counts the tenant's sessions per type and status, over all pages.
     */
    @ApiOperation({
        summary: "Get session counts per type and status",
        description:
            "Counts all stored sessions of the tenant, not one page, optionally only those created in a time range. Only the session types the caller may read are included.",
    })
    @ApiResponse({ status: 200, type: SessionStatsResponseDto })
    @Get("stats")
    async getSessionStats(
        @Token() token: TokenPayload,
        @Query() query: SessionStatsQueryDto,
    ): Promise<SessionStatsResponseDto> {
        return this.reads.stats(token.entity!.id, token, query);
    }

    /**
     * Retrieves the session information for a given session ID.
     * @param id - The identifier of the session.
     */
    @ApiParam({ name: "id", description: "The session ID", type: String })
    @ApiOperation({
        summary: "Get a session",
        description: `${READ_ONLY_NOTE} It gets the other sessions of that type without ${OMITTED_FIELDS}.`,
    })
    @ApiResponse({ status: 200, type: Session })
    @Get(":id")
    async getSession(
        @Param("id") id: string,
        @Token() token: TokenPayload,
    ): Promise<SessionData> {
        const session = await this.sessions.getForReader(
            token.entity!.id,
            id,
            sessionReadScope(token),
            readOnlySessionTypes(token),
        );
        // API keys of the webhooks the session calls are write-only.
        const redacted = redactSecrets(
            session,
            "parsedWebhook.auth.config.value",
            "credentialPayload.credentialClaims.*.webhook.auth.config.value",
        );
        return readOnlySessionTypes(token).includes(typeOfSession(session))
            ? readOnlySessionView(redacted)
            : redacted;
    }

    /**
     * Deletes a session by its ID
     * @param id
     * @param user
     * @returns
     */
    @Delete(":id")
    // sessions:read only reads sessions.
    @Secured([Role.IssuanceOffer, Role.PresentationRequest])
    @ApiResponse({ status: 204, description: "Session deleted" })
    @HttpCode(204)
    deleteSession(
        @Param("id") id: string,
        @Token() user: TokenPayload,
    ): Promise<void> {
        return this.sessions.deleteForTenant(
            user.entity!.id,
            id,
            sessionChangeScope(user),
        );
    }

    /**
     * Cancels a pending issuance offer or presentation request.
     * @param id - The session ID.
     */
    @Post(":id/cancel")
    @Secured([Role.IssuanceOffer, Role.PresentationRequest])
    @ApiParam({ name: "id", description: "The session ID", type: String })
    @ApiOperation({
        summary: "Cancel a pending offer",
        description:
            "Cancels an issuance offer or presentation request that a wallet has not redeemed yet, so it can no longer be used to start a flow. The session is kept with the status `cancelled`. Once a wallet exchanged the offer for tokens or answered the request, the session can no longer be cancelled; to revoke credentials that were already issued, use `POST /session/revoke`.",
    })
    @ApiBody({ type: CancelSessionDto, required: false })
    @ApiResponse({ status: 204, description: "Session cancelled" })
    @ApiResponse({ status: 404, description: "Session not found" })
    @ApiResponse({
        status: 409,
        description:
            "A wallet already redeemed the offer, or the session is completed, failed, expired or cancelled",
    })
    @HttpCode(204)
    async cancel(
        @Param("id") id: string,
        @Body() body: CancelSessionDto,
        @Token() token: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ): Promise<void> {
        try {
            await this.cancelSession.execute({
                tenantId: token.entity!.id,
                sessionId: id,
                scope: sessionChangeScope(token),
                reason: body.reason,
                actor: resolveAuditActor(token),
                requestMeta,
            });
        } catch (error) {
            if (error instanceof SessionNotCancellable) {
                throw new ConflictException(error.message);
            }
            throw error;
        }
    }

    /**
     * Retrieves the log entries for a given session.
     * @param id - The session ID.
     */
    @ApiParam({ name: "id", description: "The session ID", type: String })
    @ApiOperation({ summary: "Get session log entries" })
    @ApiResponse({ status: 200, type: [SessionLogEntryResponseDto] })
    @Get(":id/logs")
    async getSessionLogs(
        @Param("id") id: string,
        @Token() token: TokenPayload,
    ): Promise<SessionLogEntryResponseDto[]> {
        await this.sessions.getForReader(
            token.entity!.id,
            id,
            sessionReadScope(token),
            readOnlySessionTypes(token),
        );
        return this.logStoreService.findBySessionId(id);
    }

    /**
     * Retrieves the current status of the credentials issued in a session.
     * @param id - The session ID.
     */
    @Get(":id/credential-status")
    // Credential status is issuer data, like changing it with POST /revoke.
    @Secured([
        Role.IssuanceOffer,
        Role.Issuances,
        Role.CredentialStatus,
        Role.SessionsRead,
    ])
    @ApiParam({ name: "id", description: "The session ID", type: String })
    @ApiOperation({
        summary: "Get the status of the credentials issued in a session",
        description:
            "Lists one entry per issued credential that carries a status, with its current value in the status list and the list's bits per entry. The list is empty when no credential of the session carries a status. Change the status with `POST /session/revoke`.",
    })
    @ApiResponse({ status: 200, type: [CredentialStatusDto] })
    @ApiResponse({ status: 404, description: "Session not found" })
    async getCredentialStatus(
        @Param("id") id: string,
        @Token() token: TokenPayload,
    ): Promise<CredentialStatusDto[]> {
        await this.sessions.getForReader(
            token.entity!.id,
            id,
            credentialStatusScope(token),
            readOnlySessionTypes(token),
        );
        return this.statusListService.getSessionStatus(token.entity!.id, id);
    }

    /**
     * Update the status of the credentials of a specific session.
     * @param value
     * @returns
     */
    @Post("revoke")
    // Changing credential status is an issuer action of its own; clients that
    // only create offers (issuance:offer) or requests may not call it.
    @Secured([Role.CredentialStatus, Role.Issuances])
    @ApiOperation({
        summary: "Change the status of the credentials issued in a session",
        description:
            "Revokes (1), suspends (2) or reinstates (0) all credentials issued in the session, optionally only those of one credential configuration. Revocation is final.",
    })
    @ApiResponse({ status: 204, description: "Status updated" })
    @ApiResponse({
        status: 403,
        description:
            "The token has neither credentials:status nor issuance:manage",
    })
    @ApiResponse({
        status: 400,
        description: "The status does not fit the status list's bits per entry",
    })
    @ApiResponse({
        status: 409,
        description:
            "No status entry for the session, or a revoked credential would be reinstated or suspended",
    })
    @HttpCode(204)
    revokeAll(@Body() value: StatusUpdateDto, @Token() user: TokenPayload) {
        return this.statusListService.updateStatus(value, user.entity!.id);
    }
}
