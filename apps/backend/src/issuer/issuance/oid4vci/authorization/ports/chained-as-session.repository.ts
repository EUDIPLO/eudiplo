import type {
    ChainedAsSession,
    ChainedAsSessionStatus,
} from "../domain/chained-as-session.js";

export type NewChainedAsSession = Omit<
    ChainedAsSession,
    "createdAt" | "updatedAt"
>;

/**
 * Persistence of chained authorization server sessions. Lookups return
 * `null` when nothing matches; `save` inserts or updates the whole session.
 */
export interface ChainedAsSessionRepository {
    /** Instantiate a session that is persisted by the next `save`. */
    create(session: NewChainedAsSession): ChainedAsSession;
    save(session: ChainedAsSession): Promise<ChainedAsSession>;
    findForTenant(
        tenantId: string,
        id: string,
        status: ChainedAsSessionStatus,
    ): Promise<ChainedAsSession | null>;
    findByUpstreamState(
        tenantId: string,
        upstreamState: string,
        status?: ChainedAsSessionStatus,
    ): Promise<ChainedAsSession | null>;
    /** Session whose authorization code was issued and not yet redeemed. */
    findAuthorizedByCode(
        tenantId: string,
        authorizationCode: string,
    ): Promise<ChainedAsSession | null>;
    findByRefreshToken(
        tenantId: string,
        refreshToken: string,
    ): Promise<ChainedAsSession | null>;
    /** Session of the tenant's issuance session with this `issuer_state`. */
    findByIssuerState(
        tenantId: string,
        issuerState: string,
    ): Promise<ChainedAsSession | null>;
    /** Delete sessions that expired before `now`; returns the number deleted. */
    deleteExpired(now: Date): Promise<number>;
}

export const CHAINED_AS_SESSION_REPOSITORY = Symbol(
    "CHAINED_AS_SESSION_REPOSITORY",
);
