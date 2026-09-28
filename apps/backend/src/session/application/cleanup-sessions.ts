import {
    retentionForTenant,
    SessionCleanupMode,
    type SessionRetentionSettings,
} from "../domain/session-retention.js";
import { SessionStatus } from "../domain/session-state.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionRetentionPolicies } from "../ports/session-retention-policies.js";
import type { ChangeSessionState } from "./change-session-state.js";

type MaintenanceRepository = Pick<
    SessionRepository,
    | "findExpiredPresentationsForMaintenance"
    | "deleteSessionsCreatedBefore"
    | "anonymizeSessionsCreatedBefore"
    | "deleteOrphanedSessionsCreatedBefore"
>;

/** Privileged, cross-tenant maintenance entry point; never exposed directly to controllers. */
export class CleanupSessions {
    constructor(
        private readonly sessions: MaintenanceRepository,
        private readonly policies: SessionRetentionPolicies,
        private readonly changeState: Pick<ChangeSessionState, "execute">,
        private readonly defaults: SessionRetentionSettings,
    ) {}

    async execute(): Promise<void> {
        const expired =
            await this.sessions.findExpiredPresentationsForMaintenance(
                new Date(),
            );
        for (const session of expired) {
            await this.changeState.execute(session, SessionStatus.Expired);
        }

        const tenants = await this.policies.listForMaintenance();
        for (const tenant of tenants) {
            const policy = retentionForTenant(tenant, this.defaults);
            const cutoff = new Date(Date.now() - policy.ttlSeconds * 1000);
            if (policy.cleanupMode === SessionCleanupMode.Anonymize) {
                await this.sessions.anonymizeSessionsCreatedBefore(
                    tenant.tenantId,
                    cutoff,
                );
            } else {
                await this.sessions.deleteSessionsCreatedBefore(
                    tenant.tenantId,
                    cutoff,
                );
            }
        }

        // Preserve the existing empty-tenant guard and default orphan TTL.
        if (tenants.length > 0) {
            await this.sessions.deleteOrphanedSessionsCreatedBefore(
                tenants.map((tenant) => tenant.tenantId),
                new Date(Date.now() - this.defaults.ttlSeconds * 1000),
            );
        }
    }
}
