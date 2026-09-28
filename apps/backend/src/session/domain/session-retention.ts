export const SessionCleanupMode = {
    Full: "full",
    Anonymize: "anonymize",
} as const;
export type SessionCleanupMode =
    (typeof SessionCleanupMode)[keyof typeof SessionCleanupMode];

export interface SessionRetentionSettings {
    ttlSeconds: number;
    cleanupMode: SessionCleanupMode;
}

/** Current policy for one tenant; absent fields inherit deployment defaults. */
export interface TenantSessionRetention {
    tenantId: string;
    ttlSeconds?: number | null;
    cleanupMode?: SessionCleanupMode | null;
}

export function retentionForTenant(
    tenant: TenantSessionRetention,
    defaults: SessionRetentionSettings,
): SessionRetentionSettings {
    return {
        ttlSeconds: tenant.ttlSeconds ?? defaults.ttlSeconds,
        cleanupMode: tenant.cleanupMode ?? defaults.cleanupMode,
    };
}
