import type { SessionListQuery, SessionPage } from "../domain/session-list.js";
import {
    readOnlySessionTypes,
    type SessionCaller,
    sessionReadScope,
} from "../domain/session-scope.js";
import type { SessionStatsFilter } from "../domain/session-stats.js";
import type { SessionRetentionSettingsSource } from "../ports/session-retention-settings.js";
import type { SessionStore } from "./session-store.js";

/**
 * The session list and counts a management caller reads, with its scope and
 * the sessions hidden from it. Shared by the session endpoints and the MCP
 * tools, so both apply the same rules. `tenantId` is the caller's tenant,
 * resolved by the inbound adapter.
 */
export class SessionReads {
    constructor(
        private readonly sessions: SessionStore,
        private readonly retention: SessionRetentionSettingsSource,
    ) {}

    /** One page of the tenant's sessions that `caller` may read. */
    list(
        tenantId: string,
        caller: SessionCaller,
        query: SessionListQuery,
    ): Promise<SessionPage> {
        return this.sessions.listForTenant(
            tenantId,
            { ...query, hideOpen: readOnlySessionTypes(caller) },
            sessionReadScope(caller),
        );
    }

    /** Counts of the session types `caller` may read, with the retention. */
    async stats(
        tenantId: string,
        caller: SessionCaller,
        filter: SessionStatsFilter,
    ) {
        const [stats, retention] = await Promise.all([
            this.sessions.statsForTenant(
                tenantId,
                sessionReadScope(caller),
                filter,
            ),
            this.retention.forTenant(tenantId),
        ]);
        return { ...stats, retention };
    }
}
