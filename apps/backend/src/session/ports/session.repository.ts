import type { CredentialOfferObject } from "@openid4vc/openid4vci";
import type {
    ExternalSessionBinding,
    NewSession,
    SessionData,
    SessionUpdate,
} from "../domain/session-data.js";
import type {
    SessionListQuery,
    SessionSummary,
} from "../domain/session-list.js";

import type {
    SessionLifecycleContext,
    SessionStateUpdate,
    SessionStatus,
} from "../domain/session-state.js";

export const SESSION_REPOSITORY = Symbol("SESSION_REPOSITORY");

/** The offer view is deliberately independent of the persisted Session entity. */
export interface SessionCredentialOffer {
    offer: CredentialOfferObject | null;
}

/** Migrated session operations. Extend by use case, never with ORM query types. */
export interface SessionRepository {
    create(session: NewSession): Promise<SessionData>;
    updateForTenant(
        tenantId: string,
        id: string,
        update: SessionUpdate,
    ): Promise<number>;
    findForTenant(tenantId: string, id: string): Promise<SessionData | null>;
    /** Internal flow correlation only; never use an untrusted management request ID. */
    findByIdForInternalFlow(id: string): Promise<SessionData | null>;
    /** Wallet nonce first, then legacy session-ID fallback for existing wallet URLs. */
    findForWalletRequest(nonce: string): Promise<SessionData | null>;
    findIso18013Session(id: string): Promise<SessionData | null>;
    findByAuthorizationCode(
        tenantId: string,
        code: string,
    ): Promise<SessionData | null>;
    findByRefreshToken(
        tenantId: string,
        token: string,
    ): Promise<SessionData | null>;
    findByRequestUri(
        tenantId: string,
        uri: string,
    ): Promise<SessionData | null>;
    /** Bind only an existing active session for the configured server; return the pre-update snapshot. */
    bindExternalAuthorization(
        binding: ExternalSessionBinding,
    ): Promise<SessionData | null>;

    /**
     * Atomically increment, then read the current count in the same tenant scope.
     * Concurrent callers may observe the same count; no increments may be lost.
     * Return null if the session is missing.
     */
    incrementFailedTxCodeAttempts(
        tenantId: string,
        sessionId: string,
    ): Promise<number | null>;

    listForTenant(
        tenantId: string,
        query: SessionListQuery,
    ): Promise<{ items: SessionSummary[]; total: number }>;
    /** Missing sessions and sessions owned by another tenant are both no-ops. */
    deleteForTenant(tenantId: string, sessionId: string): Promise<void>;

    /** Privileged cross-tenant selection: only overdue active/fetched presentations. */
    findExpiredPresentationsForMaintenance(
        before: Date,
    ): Promise<SessionLifecycleContext[]>;
    countSessionsForMaintenance(
        tenantId: string,
        kind: "issuance" | "verification",
        status: SessionStatus,
    ): Promise<number>;
    deleteSessionsCreatedBefore(
        tenantId: string,
        cutoff: Date,
    ): Promise<number>;
    anonymizeSessionsCreatedBefore(
        tenantId: string,
        cutoff: Date,
    ): Promise<number>;
    /** An empty known-tenant list must be a no-op, never a global delete. */
    deleteOrphanedSessionsCreatedBefore(
        knownTenantIds: string[],
        cutoff: Date,
    ): Promise<number>;

    /** Preserve existing update semantics; no compare-and-set or deduplication. */
    changeState(
        tenantId: string,
        sessionId: string,
        update: SessionStateUpdate,
    ): Promise<void>;

    findCredentialOffer(
        tenantId: string,
        sessionId: string,
    ): Promise<SessionCredentialOffer | null>;

    /**
     * Atomically clear a non-null offer for this tenant. Exactly one concurrent
     * caller wins. Preserve consumedAt if already set; do not change consumed.
     */
    consumeCredentialOffer(
        tenantId: string,
        sessionId: string,
    ): Promise<boolean>;
}
