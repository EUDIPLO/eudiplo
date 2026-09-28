import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Query,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { StatusUpdateDto } from "../issuer/status-list/dto/status-update.dto.js";
import { StatusListService } from "../issuer/status-list/status-list.service.js";
import { DeleteSession } from "./application/delete-session.js";
import { GetSessionForTenant } from "./application/get-session-for-tenant.js";
import { ListSessions } from "./application/list-sessions.js";
import type { SessionData } from "./domain/session-data.js";
import { PaginatedSessionResponseDto } from "./dto/paginated-session-response.dto.js";
import { SessionLogEntryResponseDto } from "./dto/session-log-entry-response.dto.js";
import { SessionQueryDto } from "./dto/session-query.dto.js";
import { Session } from "./entities/session.entity.js";
import { SessionLogStoreService } from "./logging/session-log-store.service.js";

@ApiTags("Session")
@Secured([Role.IssuanceOffer, Role.PresentationRequest])
@Controller("session")
export class SessionController {
    constructor(
        private readonly listSessions: ListSessions,
        private readonly deleteSessionUseCase: DeleteSession,
        private readonly getSessionForTenant: GetSessionForTenant,
        private readonly statusListService: StatusListService,
        private readonly logStoreService: SessionLogStoreService,
    ) {}

    /**
     * Retrieves a paginated list of sessions with optional filters.
     */
    @ApiOperation({ summary: "Get sessions (paginated)" })
    @ApiResponse({ status: 200, type: PaginatedSessionResponseDto })
    @Get()
    getAllSessions(
        @Token() token: TokenPayload,
        @Query() query: SessionQueryDto,
    ): Promise<PaginatedSessionResponseDto> {
        return this.listSessions.execute(token.entity!.id, query);
    }

    /**
     * Retrieves the session information for a given session ID.
     * @param id - The identifier of the session.
     */
    @ApiParam({ name: "id", description: "The session ID", type: String })
    @ApiResponse({ status: 200, type: Session })
    @Get(":id")
    getSession(
        @Param("id") id: string,
        @Token() token: TokenPayload,
    ): Promise<SessionData> {
        return this.getSessionForTenant.execute(token.entity!.id, id);
    }

    /**
     * Deletes a session by its ID
     * @param id
     * @param user
     * @returns
     */
    @Delete(":id")
    @ApiResponse({ status: 204, description: "Session deleted" })
    @HttpCode(204)
    deleteSession(
        @Param("id") id: string,
        @Token() user: TokenPayload,
    ): Promise<void> {
        return this.deleteSessionUseCase.execute(user.entity!.id, id);
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
        await this.getSessionForTenant.execute(token.entity!.id, id);
        return this.logStoreService.findBySessionId(id);
    }

    /**
     * Update the status of the credentials of a specific session.
     * @param value
     * @returns
     */
    @Post("revoke")
    @ApiResponse({ status: 204, description: "All sessions revoked" })
    @HttpCode(204)
    revokeAll(@Body() value: StatusUpdateDto, @Token() user: TokenPayload) {
        return this.statusListService.updateStatus(value, user.entity!.id);
    }
}
