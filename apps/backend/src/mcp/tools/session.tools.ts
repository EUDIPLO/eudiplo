import { Injectable } from "@nestjs/common";
import { type McpContext, Tool } from "@nestjs/mcp";
import type { z } from "zod";
import { Role } from "../../auth/roles/role.enum.js";
import { SessionStore } from "../../session/application/session-store.js";
import { SessionQuerySchema } from "../../session/dto/session-query.dto.js";
import { SessionStatsQuerySchema } from "../../session/dto/session-stats-query.dto.js";
import { SessionConfigService } from "../../session/session-config.service.js";
import {
    readOnlySessionTypes,
    sessionReadScope,
} from "../../session/session-scope.js";
import { callerOf, type McpRequest, tenantOf } from "../mcp-caller.js";
import { McpSecured } from "../mcp-secured.decorator.js";

/** The roles of the session endpoints that read sessions. */
const SESSION_READERS = [
    Role.IssuanceOffer,
    Role.PresentationRequest,
    Role.SessionsRead,
];

/**
 * Session reads with the rules of `GET /api/session` and
 * `GET /api/session/stats`: the same query schemas, scope and hidden
 * sessions. Only the session summaries and counts leave the server, never
 * claims, presented credentials or the values a wallet redeems a session
 * with.
 */
@Injectable()
export class SessionTools {
    constructor(
        private readonly sessions: SessionStore,
        private readonly sessionConfig: SessionConfigService,
    ) {}

    @Tool({
        name: "list_sessions",
        title: "List sessions",
        description:
            "Lists the tenant's issuance and presentation sessions, newest first, one page at a time: id, status, creation, update and expiry time, presentation configuration (requestId), failure code and caller reference. No claims or credentials. Filters combine: status (one or several of active, fetched, completed, expired, failed, cancelled), type (issuance or presentation), createdFrom/createdTo and updatedFrom/updatedTo (ISO 8601 with offset), requestId, credentialConfigurationId, failureCode, id (start of a session id) and q (free text). pageSize is at most 100. A client with only sessions:read for a type does not see that type's sessions a wallet can still redeem or answer.",
        inputSchema: SessionQuerySchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
    })
    @McpSecured(SESSION_READERS)
    listSessions(
        query: z.output<typeof SessionQuerySchema>,
        context: McpContext<McpRequest>,
    ) {
        const token = callerOf(context);
        return this.sessions.listForTenant(
            tenantOf(token),
            { ...query, hideOpen: readOnlySessionTypes(token) },
            sessionReadScope(token),
        );
    }

    @Tool({
        name: "get_session_stats",
        title: "Get session statistics",
        description:
            "Counts the tenant's sessions per type and status over all pages, with the most frequent failure codes and the session retention settings. createdFrom/createdTo (ISO 8601 with offset) limit the count to a creation time range. Only the session types the caller may read are counted.",
        inputSchema: SessionStatsQuerySchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
    })
    @McpSecured(SESSION_READERS)
    async getSessionStats(
        query: z.output<typeof SessionStatsQuerySchema>,
        context: McpContext<McpRequest>,
    ) {
        const token = callerOf(context);
        const tenantId = tenantOf(token);
        const [stats, retention] = await Promise.all([
            this.sessions.statsForTenant(
                tenantId,
                sessionReadScope(token),
                query,
            ),
            this.sessionConfig.getEffectiveConfig(tenantId),
        ]);
        return { ...stats, retention };
    }
}
