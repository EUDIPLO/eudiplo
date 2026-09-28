export enum SessionStatus {
    Active = "active",
    Fetched = "fetched",
    Completed = "completed",
    Expired = "expired",
    Failed = "failed",
}

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
    const terminal =
        status === SessionStatus.Completed ||
        status === SessionStatus.Failed ||
        status === SessionStatus.Expired;
    return {
        status,
        ...(terminal ? { responseEncryptionPrivateJwk: null } : {}),
    };
}
