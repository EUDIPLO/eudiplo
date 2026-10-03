export enum SessionStatus {
    Active = "active",
    Fetched = "fetched",
    Completed = "completed",
    Expired = "expired",
    Failed = "failed",
}

/**
 * Final statuses: a wallet can no longer redeem the session, and no later
 * wallet request may change its status. New terminal statuses (e.g. a revoked
 * offer) only need to be added here.
 */
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
    SessionStatus.Completed,
    SessionStatus.Failed,
    SessionStatus.Expired,
]);

export function isTerminalStatus(status: SessionStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}

/** Statuses in which a wallet may still use the session. */
export const OPEN_SESSION_STATUSES: readonly SessionStatus[] = Object.values(
    SessionStatus,
).filter((status) => !isTerminalStatus(status));

/** Only the identity and classification needed for lifecycle operations. */
export interface SessionLifecycleContext {
    id: string;
    tenantId: string;
    requestId?: string | null;
}

export interface SessionStateUpdate {
    status: SessionStatus;
    responseEncryptionPrivateJwk?: null;
}

export function stateUpdate(status: SessionStatus): SessionStateUpdate {
    return {
        status,
        ...(isTerminalStatus(status)
            ? { responseEncryptionPrivateJwk: null }
            : {}),
    };
}
