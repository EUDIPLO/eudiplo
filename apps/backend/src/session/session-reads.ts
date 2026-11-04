import { Injectable } from "@nestjs/common";
import type { TokenPayload } from "../auth/token.decorator.js";
import { SessionStore } from "./application/session-store.js";
import type { SessionListQuery, SessionPage } from "./domain/session-list.js";
import type { SessionStatsFilter } from "./domain/session-stats.js";
import { SessionConfigService } from "./session-config.service.js";
import { readOnlySessionTypes, sessionReadScope } from "./session-scope.js";

/**
 * The session list and counts a management caller reads, with its scope and
 * the sessions hidden from it. Shared by the session endpoints and the MCP
 * tools, so both apply the same rules.
 */
@Injectable()
export class SessionReads {
    constructor(
        private readonly sessions: SessionStore,
        private readonly sessionConfig: SessionConfigService,
    ) {}

    /** One page of the tenant's sessions that `token` may read. */
    list(
        tenantId: string,
        token: TokenPayload,
        query: SessionListQuery,
    ): Promise<SessionPage> {
        return this.sessions.listForTenant(
            tenantId,
            { ...query, hideOpen: readOnlySessionTypes(token) },
            sessionReadScope(token),
        );
    }

    /** Counts of the session types `token` may read, with the retention settings. */
    async stats(
        tenantId: string,
        token: TokenPayload,
        filter: SessionStatsFilter,
    ) {
        const [stats, retention] = await Promise.all([
            this.sessions.statsForTenant(
                tenantId,
                sessionReadScope(token),
                filter,
            ),
            this.sessionConfig.getEffectiveConfig(tenantId),
        ]);
        return { ...stats, retention };
    }
}
