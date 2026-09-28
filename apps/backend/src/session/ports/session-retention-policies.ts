import type { TenantSessionRetention } from "../domain/session-retention.js";

export const SESSION_RETENTION_POLICIES = Symbol("SESSION_RETENTION_POLICIES");

/** Privileged maintenance view; deliberately not a general tenant repository. */
export interface SessionRetentionPolicies {
    listForMaintenance(): Promise<TenantSessionRetention[]>;
}
