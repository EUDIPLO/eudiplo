import { type McpContext, Tool } from "@nestjs/mcp";
import type { z } from "zod";
import { Role } from "../../auth/roles/role.enum.js";
import type { SessionPage } from "../../session/domain/session-list.js";
import type {
    SessionFailureCodeCount,
    SessionStats,
} from "../../session/domain/session-stats.js";
import { SessionQuerySchema } from "../../session/dto/session-query.dto.js";
import { SessionStatsQuerySchema } from "../../session/dto/session-stats-query.dto.js";
import { SessionReads } from "../../session/session-reads.js";
import { callerOf, type McpRequest, tenantOf } from "../mcp-caller.js";
import { McpSecured, McpTools } from "../mcp-secured.decorator.js";

/** The roles of the session endpoints that read sessions. */
const SESSION_READERS = [
    Role.IssuanceOffer,
    Role.PresentationRequest,
    Role.SessionsRead,
];

/**
 * What a failure code looks like: EUDIPLO's own codes and the OAuth error
 * codes of wallets. A wallet chooses the `error` of its error response
 * freely, and the assistant would read any other text as part of the
 * server's answer, instructions included.
 */
const FAILURE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Shown instead of a failure code that does not look like one. */
export const WITHHELD_FAILURE_CODE = "[withheld]";

function shownFailureCode(code: string): string {
    return FAILURE_CODE.test(code) ? code : WITHHELD_FAILURE_CODE;
}

function withShownFailureCodes(page: SessionPage): SessionPage {
    return {
        ...page,
        items: page.items.map((item) => ({
            ...item,
            failureCode:
                item.failureCode === null
                    ? null
                    : shownFailureCode(item.failureCode),
        })),
    };
}

/** Withheld codes are counted together, most frequent first as before. */
function shownFailureCodeCounts(
    counts: SessionFailureCodeCount[],
): SessionFailureCodeCount[] {
    const merged = new Map<string, number>();
    for (const { code, count } of counts) {
        const shown = shownFailureCode(code);
        merged.set(shown, (merged.get(shown) ?? 0) + count);
    }
    return [...merged]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count);
}

function withShownFailureCodeCounts(stats: SessionStats): SessionStats {
    return Object.fromEntries(
        Object.entries(stats).map(([type, typeStats]) => [
            type,
            {
                ...typeStats,
                failureCodes: shownFailureCodeCounts(typeStats.failureCodes),
            },
        ]),
    );
}

/**
 * Session reads of `GET /api/session` and `GET /api/session/stats`: the same
 * query schemas and {@link SessionReads}. Only the session summaries and
 * counts leave the server, never claims, presented credentials or the values
 * a wallet redeems a session with, and failure codes only when they look
 * like one.
 */
@McpTools()
export class SessionTools {
    constructor(private readonly reads: SessionReads) {}

    @Tool({
        name: "list_sessions",
        title: "List sessions",
        description:
            "Lists the tenant's issuance and presentation sessions, most recently updated first, one page at a time: id, status, creation, update and expiry time, presentation configuration (requestId), failure code and caller reference. No claims or credentials. A failure code a wallet sent that is not a short code comes as [withheld]. Filters combine: status (one or several of active, fetched, completed, expired, failed, cancelled), type (issuance or presentation), createdFrom/createdTo and updatedFrom/updatedTo (ISO 8601 with offset), requestId, credentialConfigurationId, failureCode, id (start of a session id) and q (free text). pageSize is at most 100. A client with only sessions:read for a type does not see that type's sessions a wallet can still redeem or answer.",
        inputSchema: SessionQuerySchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
    })
    @McpSecured(SESSION_READERS)
    async listSessions(
        query: z.output<typeof SessionQuerySchema>,
        context: McpContext<McpRequest>,
    ) {
        const token = callerOf(context);
        const page = await this.reads.list(tenantOf(token), token, query);
        return withShownFailureCodes(page);
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
        const { retention, ...stats } = await this.reads.stats(
            tenantOf(token),
            token,
            query,
        );
        return { ...withShownFailureCodeCounts(stats), retention };
    }
}
