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
import { SessionReads } from "../../session/application/session-reads.js";
import type { VerificationFailureType } from "../../verifier/presentations/credential/verification-failure.js";
import { CLAIM_VALUE_MISMATCH } from "../../verifier/presentations/domain/dcql-claim-policy.js";
import { callerOf, type McpRequest, tenantOf } from "../mcp-caller.js";
import { McpSecured, McpTools } from "../mcp-secured.decorator.js";

/** The roles of the session endpoints that read sessions. */
const SESSION_READERS = [
    Role.IssuanceOffer,
    Role.PresentationRequest,
    Role.SessionsRead,
];

/** Every verification failure; the type makes a new one fail to compile. */
const VERIFICATION_FAILURES: Record<VerificationFailureType, true> = {
    signature_invalid: true,
    no_trust_chain_to_root: true,
    trust_chain_not_trusted: true,
    trust_list_unavailable: true,
    certificate_expired: true,
    x5c_missing: true,
    verification_error: true,
};

/**
 * The failure codes the tools show: EUDIPLO's own (session outcome
 * reference) and the error codes OAuth 2.0 (RFC 6749, section 4.1.2.1) and
 * OpenID4VP 1.0 (section 8.5) define for wallets. A wallet chooses the
 * `error` of its error response freely, and the assistant would read any
 * other text as part of the server's answer, instructions included.
 */
const SHOWN_FAILURE_CODES = new Set<string>([
    ...Object.keys(VERIFICATION_FAILURES),
    CLAIM_VALUE_MISMATCH,
    "credential_failure",
    "credential_deleted",
    "invalid_request",
    "unauthorized_client",
    "access_denied",
    "unsupported_response_type",
    "invalid_scope",
    "server_error",
    "temporarily_unavailable",
    "vp_formats_not_supported",
    "invalid_request_uri_method",
    "invalid_transaction_data",
    "wallet_unavailable",
]);

/** Shown instead of a failure code that is not one of those. */
export const WITHHELD_FAILURE_CODE = "[withheld]";

function shownFailureCode(code: string): string {
    return SHOWN_FAILURE_CODES.has(code) ? code : WITHHELD_FAILURE_CODE;
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
 * a wallet redeems a session with, and failure codes only when they are
 * known ones.
 */
@McpTools()
export class SessionTools {
    constructor(private readonly reads: SessionReads) {}

    @Tool({
        name: "list_sessions",
        title: "List sessions",
        description:
            "Lists the tenant's issuance and presentation sessions, most recently updated first, one page at a time: id, status, creation, update and expiry time, presentation configuration (requestId), failure code and caller reference. No claims or credentials. A failure code that is neither EUDIPLO's own nor an OAuth 2.0 or OpenID4VP error code comes as [withheld], since wallets choose them. Filters combine: status (one or several of active, fetched, completed, expired, failed, cancelled), type (issuance or presentation), createdFrom/createdTo and updatedFrom/updatedTo (ISO 8601 with offset), requestId, credentialConfigurationId, failureCode, id (start of a session id) and q (free text). pageSize is at most 100. A client with only sessions:read for a type does not see that type's sessions a wallet can still redeem or answer.",
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
