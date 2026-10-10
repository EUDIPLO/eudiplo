import type { SessionData, SessionUpdate } from "../domain/session-data.js";
import type {
    SessionListQuery,
    SessionPage,
    SessionType,
} from "../domain/session-list.js";
import type {
    SessionCredentialOffer,
    SessionRepository,
} from "../ports/session.repository.js";
import {
    NO_SESSION_CONTEXT,
    type SessionContext,
} from "../ports/session-context.js";
import { SessionNotFound } from "./session-errors.js";

/** The repository operations other features may reach; maintenance stays internal. */
type SessionStoreRepository = Pick<
    SessionRepository,
    | "findForTenant"
    | "findByIdForInternalFlow"
    | "findForWalletRequest"
    | "findIso18013Session"
    | "findByAuthorizationCode"
    | "findByRefreshToken"
    | "findByRequestUri"
    | "updateForTenant"
    | "updateUnconsumedForTenant"
    | "consumeRequestUri"
    | "listForTenant"
    | "deleteForTenant"
    | "findCredentialOffer"
    | "consumeCredentialOffer"
>;

/**
 * Session reads and writes shared by the protocol and management flows.
 * Every `get*` method throws {@link SessionNotFound} (HTTP 404) when no session
 * matches, and never queries with an empty key: an absent column value in a
 * TypeORM `where` clause would otherwise match any session.
 * Every resolved session is bound to the current request's context.
 *
 * The management methods take an optional `scope`: the only session type the
 * caller may access. Sessions of the other type then read as missing.
 */
export class SessionStore {
    constructor(
        private readonly sessions: SessionStoreRepository,
        private readonly context: SessionContext = NO_SESSION_CONTEXT,
    ) {}

    getForTenant(
        tenantId: string,
        sessionId: string | undefined,
        scope?: SessionType,
    ): Promise<SessionData> {
        return this.lookup(sessionId, (id) =>
            this.sessions.findForTenant(tenantId, id, scope),
        );
    }

    getByAuthorizationCode(
        tenantId: string,
        codeHash: string | undefined,
    ): Promise<SessionData> {
        return this.lookup(codeHash, (value) =>
            this.sessions.findByAuthorizationCode(tenantId, value),
        );
    }

    getByRefreshToken(
        tenantId: string,
        refreshTokenHash: string,
    ): Promise<SessionData> {
        return this.lookup(refreshTokenHash, (value) =>
            this.sessions.findByRefreshToken(tenantId, value),
        );
    }

    getByRequestUri(tenantId: string, uri: string): Promise<SessionData> {
        return this.lookup(uri, (value) =>
            this.sessions.findByRequestUri(tenantId, value),
        );
    }

    /** Wallet nonce first, then the legacy session-ID fallback. */
    getForWalletRequest(nonce: string): Promise<SessionData> {
        return this.lookup(nonce, (value) =>
            this.sessions.findForWalletRequest(value),
        );
    }

    /** Unscoped: only for IDs from internal flow correlation, never from a management request. */
    getForInternalFlow(sessionId: string): Promise<SessionData> {
        return this.lookup(sessionId, (id) =>
            this.sessions.findByIdForInternalFlow(id),
        );
    }

    getIso18013(sessionId: string): Promise<SessionData> {
        return this.lookup(sessionId, (id) =>
            this.sessions.findIso18013Session(id),
        );
    }

    /** Returns the number of updated sessions (0 when missing or owned by another tenant). */
    updateForTenant(
        tenantId: string,
        sessionId: string,
        update: SessionUpdate,
    ): Promise<number> {
        return this.sessions.updateForTenant(tenantId, sessionId, update);
    }

    /** Single-use update: returns whether this call won against concurrent callers. */
    updateIfUnconsumed(
        tenantId: string,
        sessionId: string,
        update: SessionUpdate,
    ): Promise<boolean> {
        return this.sessions.updateUnconsumedForTenant(
            tenantId,
            sessionId,
            update,
        );
    }

    /** Single-use PAR request_uri: returns whether this call redeemed it. */
    consumeRequestUri(
        tenantId: string,
        sessionId: string,
        expiresAt: Date,
        now: Date,
    ): Promise<boolean> {
        return this.sessions.consumeRequestUri(
            tenantId,
            sessionId,
            expiresAt,
            now,
        );
    }

    async listForTenant(
        tenantId: string,
        query: SessionListQuery,
        scope?: SessionType,
    ): Promise<SessionPage> {
        // A type filter outside the scope matches no session.
        const { items, total } =
            scope && query.type && query.type !== scope
                ? { items: [], total: 0 }
                : await this.sessions.listForTenant(tenantId, {
                      ...query,
                      type: query.type ?? scope,
                  });
        return {
            items,
            total,
            page: query.page,
            pageSize: query.pageSize,
            totalPages: Math.ceil(total / query.pageSize),
        };
    }

    /** Missing sessions, other tenants' sessions and sessions outside `scope` are no-ops. */
    deleteForTenant(
        tenantId: string,
        sessionId: string,
        scope?: SessionType,
    ): Promise<void> {
        return this.sessions.deleteForTenant(tenantId, sessionId, scope);
    }

    async findCredentialOffer(
        tenantId: string,
        sessionId: string,
    ): Promise<SessionCredentialOffer | null> {
        const offer = await this.sessions.findCredentialOffer(
            tenantId,
            sessionId,
        );
        if (offer) this.context.bind({ id: sessionId, tenantId });
        return offer;
    }

    /** Atomically clears a pending offer; exactly one concurrent caller wins. */
    consumeCredentialOffer(
        tenantId: string,
        sessionId: string,
    ): Promise<boolean> {
        return this.sessions.consumeCredentialOffer(tenantId, sessionId);
    }

    private async lookup(
        key: string | undefined,
        find: (key: string) => Promise<SessionData | null>,
    ): Promise<SessionData> {
        if (!key) throw new SessionNotFound();
        const session = await find(key);
        if (!session) throw new SessionNotFound();
        this.context.bind(session);
        return session;
    }
}
