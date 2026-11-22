import type { SessionData, SessionUpdate } from "../domain/session-data.js";
import {
    hasConfigLimits,
    type SessionConfigLimits,
    type SessionListQuery,
    type SessionPage,
    type SessionType,
    typeOfSession,
    withinConfigLimits,
} from "../domain/session-list.js";
import { isOpenForWallet, SessionStatus } from "../domain/session-state.js";
import {
    MAX_FAILURE_CODES,
    type SessionStats,
    type SessionStatsFilter,
    sessionTypeStats,
} from "../domain/session-stats.js";
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
    | "findIssuanceForWalletReference"
    | "findIso18013Session"
    | "findByAuthorizationCode"
    | "findByRefreshToken"
    | "findByRequestUri"
    | "updateForTenant"
    | "updateUnconsumedForTenant"
    | "consumeRequestUri"
    | "listForTenant"
    | "countForTenant"
    | "topFailureCodesForTenant"
    | "lastUpdatedForTenant"
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
 * caller may access. Sessions of the other type then read as missing. With
 * `limits`, the client's allowed configurations, so do the sessions of other
 * configurations.
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
        limits?: SessionConfigLimits,
    ): Promise<SessionData> {
        return this.lookup(sessionId, async (id) => {
            const session = await this.sessions.findForTenant(
                tenantId,
                id,
                scope,
            );
            return session && withinConfigLimits(session, limits)
                ? session
                : null;
        });
    }

    /**
     * A session for a management read: within `scope`, and missing when it is
     * outside `limits`, or of a type in `hideOpen` and still open for a
     * wallet, like the list with the same `hideOpen` and `configLimits`.
     */
    async getForReader(
        tenantId: string,
        sessionId: string,
        scope?: SessionType,
        hideOpen: readonly SessionType[] = [],
        limits?: SessionConfigLimits,
    ): Promise<SessionData> {
        const session = await this.getForTenant(
            tenantId,
            sessionId,
            scope,
            limits,
        );
        if (
            hideOpen.includes(typeOfSession(session)) &&
            isOpenForWallet(session)
        )
            throw new SessionNotFound();
        return session;
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

    /** The session of a wallet-facing OID4VP nonce; never by session ID. */
    getForWalletRequest(nonce: string): Promise<SessionData> {
        return this.lookup(nonce, (value) =>
            this.sessions.findForWalletRequest(value),
        );
    }

    /**
     * The issuance session a wallet names with `issuer_state`, the
     * `credential_offer_uri` or an external token binding; never by session ID.
     */
    getIssuanceForWalletReference(
        tenantId: string,
        reference: string | undefined,
    ): Promise<SessionData> {
        return this.lookup(reference, (value) =>
            this.sessions.findIssuanceForWalletReference(tenantId, value),
        );
    }

    /** Unscoped: only for IDs from internal flow correlation, never from a management request. */
    getForInternalFlow(sessionId: string): Promise<SessionData> {
        return this.lookup(sessionId, (id) =>
            this.sessions.findByIdForInternalFlow(id),
        );
    }

    /** The ISO 18013-7 session of a wallet nonce; never by session ID. */
    getIso18013(walletNonce: string): Promise<SessionData> {
        return this.lookup(walletNonce, (value) =>
            this.sessions.findIso18013Session(value),
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

    /**
     * Session counts per type, status and failure code, for the types in
     * `scope` and the configurations in `configLimits` only.
     */
    async statsForTenant(
        tenantId: string,
        scope?: SessionType,
        range: SessionStatsFilter = {},
        configLimits?: SessionConfigLimits,
    ): Promise<SessionStats> {
        const filter = { ...range, configLimits };
        const types: SessionType[] = scope
            ? [scope]
            : ["issuance", "presentation"];
        const [counts, perType] = await Promise.all([
            this.sessions.countForTenant(tenantId, { ...filter, type: scope }),
            Promise.all(
                types.map((type) =>
                    Promise.all([
                        this.sessions.topFailureCodesForTenant(
                            tenantId,
                            { ...filter, type },
                            MAX_FAILURE_CODES,
                        ),
                        this.sessions.lastUpdatedForTenant(tenantId, {
                            ...filter,
                            type,
                            status: SessionStatus.Completed,
                        }),
                    ]),
                ),
            ),
        ]);
        return Object.fromEntries(
            types.map((type, index) => {
                const [failureCodes, lastCompletedAt] = perType[index];
                return [
                    type,
                    sessionTypeStats(
                        type,
                        counts,
                        failureCodes,
                        lastCompletedAt,
                    ),
                ];
            }),
        );
    }

    /**
     * Missing sessions, other tenants' sessions and sessions outside `scope`
     * or `limits` are no-ops.
     */
    async deleteForTenant(
        tenantId: string,
        sessionId: string,
        scope?: SessionType,
        limits?: SessionConfigLimits,
    ): Promise<void> {
        if (hasConfigLimits(limits)) {
            // The configurations of a session never change, so reading
            // before deleting cannot race.
            const session = await this.sessions.findForTenant(
                tenantId,
                sessionId,
                scope,
            );
            if (!session || !withinConfigLimits(session, limits)) return;
        }
        return this.sessions.deleteForTenant(tenantId, sessionId, scope);
    }

    /** The offer of the issuance session with this wallet reference. */
    async findCredentialOffer(
        tenantId: string,
        walletReference: string,
    ): Promise<SessionCredentialOffer | null> {
        const offer = await this.sessions.findCredentialOffer(
            tenantId,
            walletReference,
        );
        if (offer) this.context.bind({ id: offer.id, tenantId });
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
