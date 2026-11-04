import type { SessionRetentionSettings } from "../domain/session-retention.js";

export const SESSION_RETENTION_SETTINGS = Symbol("SESSION_RETENTION_SETTINGS");

/** The retention of a tenant's sessions: its own settings or the defaults. */
export interface SessionRetentionSettingsSource {
    forTenant(tenantId: string): Promise<SessionRetentionSettings>;
}
