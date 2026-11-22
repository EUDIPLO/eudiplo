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
import { SessionConfigService } from "./session-config.service.js";
import {
    credentialStatusScope,
    readOnlySessionTypes,
    sessionChangeScope,
    sessionConfigLimits,
    sessionReadScope,
} from "./session-scope.js";

/** How the session reads treat a client with only `sessions:read` for a type. */
const READ_ONLY_NOTE =
    "A client that reads sessions of a type through `sessions:read` but cannot cancel or delete them (that needs `issuance:offer` or `presentation:request`, and `issuance:offer` or `issuance:manage` for issuance sessions, `presentation:request` or `presentation:manage` for presentation sessions) does not get the sessions of that type that a wallet can still redeem or answer (open status, not consumed): they are left out of the list and answer 404, since their ID is enough to redeem or answer them.";

/** How the session endpoints treat a client with `allowedIssuanceConfigs` or `allowedPresentationConfigs`. */
const CONFIG_LIMITS_NOTE =
    "A client limited to some configurations (`allowedIssuanceConfigs`, `allowedPresentationConfigs`) gets only the sessions of those configurations: the others are left out of the list and the counts and answer 404.";

/** The 404 of a session the caller may not access. */
const NOT_FOUND_NOTE =
    "No session with this ID in the tenant, or a session of another type than the client's roles cover or of a configuration outside the client's limits";

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
        private readonly sessionConfig: SessionConfigService,
    ) {}

    /**
     * Retrieves a paginated list of sessions with optional filters.
     */
    @ApiOperation({
        summary: "Get sessions (paginated)",
        description: `${READ_ONLY_NOTE} ${CONFIG_LIMITS_NOTE}`,
    })
    @ApiResponse({ status: 200, type: PaginatedSessionResponseDto })
    @Get()
    getAllSessions(
        @Token() token: TokenPayload,
        @Query() query: SessionQueryDto,
    ): Promise<PaginatedSessionResponseDto> {
        return this.sessions.listForTenant(
            token.entity!.id,
            {
                ...query,
                hideOpen: readOnlySessionTypes(token),
                configLimits: sessionConfigLimits(token),
            },
            sessionReadScope(token),
        );
    }

    /**
     * Counts the tenant's sessions per type and status, over all pages.
     */
    @ApiOperation({
        summary: "Get session counts per type and status",
        description:
            "Counts all stored sessions of the tenant, not one page, optionally only those created in a time range. Only the session types and, for a client limited to some configurations, the configurations the caller may read are included.",
    })
    @ApiResponse({ status: 200, type: SessionStatsResponseDto })
    @Get("stats")
    async getSessionStats(
        @Token() token: TokenPayload,
        @Query() query: SessionStatsQueryDto,
    ): Promise<SessionStatsResponseDto> {
        const tenantId = token.entity!.id;
        const [stats, retention] = await Promise.all([
            this.sessions.statsForTenant(
                tenantId,
                sessionReadScope(token),
                query,
                sessionConfigLimits(token),
            ),
            this.sessionConfig.getEffectiveConfig(tenantId),
        ]);
        return { ...stats, retention };
    }

    /**
     * Retrieves the session information for a given session ID.
     * @param id - The identifier of the session.
     */
    @ApiParam({ name: "id", description: "The session ID", type: String })
    @ApiOperation({
        summary: "Get a session",
        description: `${READ_ONLY_NOTE} It gets the other sessions of that type without ${OMITTED_FIELDS}. ${CONFIG_LIMITS_NOTE}`,
    })
    @ApiResponse({ status: 200, type: Session })
    @ApiResponse({ status: 404, description: NOT_FOUND_NOTE })
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
            sessionConfigLimits(token),
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
    @ApiResponse({
        status: 204,
        description:
            "Session deleted. A missing session, a session of another type than the client's roles cover and a session of a configuration outside the client's limits are left untouched and answer 204 as well.",
    })
    @HttpCode(204)
    deleteSession(
        @Param("id") id: string,
        @Token() user: TokenPayload,
    ): Promise<void> {
        return this.sessions.deleteForTenant(
            user.entity!.id,
            id,
            sessionChangeScope(user),
            sessionConfigLimits(user),
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
    @ApiResponse({ status: 404, description: NOT_FOUND_NOTE })
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
                limits: sessionConfigLimits(token),
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
    @ApiResponse({ status: 404, description: NOT_FOUND_NOTE })
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
            sessionConfigLimits(token),
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
    @ApiResponse({ status: 404, description: NOT_FOUND_NOTE })
    async getCredentialStatus(
        @Param("id") id: string,
        @Token() token: TokenPayload,
    ): Promise<CredentialStatusDto[]> {
        await this.sessions.getForReader(
            token.entity!.id,
            id,
            credentialStatusScope(token),
            readOnlySessionTypes(token),
            sessionConfigLimits(token),
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
            "Revokes (1), suspends (2) or reinstates (0) all credentials issued in the session, optionally only those of one credential configuration. Revocation is final. A client limited to some credential configurations (`allowedIssuanceConfigs`) changes only credentials of those; a request that covers a credential of another configuration answers 409 and changes nothing.",
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
            "No status entry for the session, one of a credential configuration outside the client's limits, or a revoked credential would be reinstated or suspended",
    })
    @HttpCode(204)
    revokeAll(@Body() value: StatusUpdateDto, @Token() user: TokenPayload) {
        return this.statusListService.updateStatus(
            value,
            user.entity!.id,
            sessionConfigLimits(user).issuance,
        );
    }
}
