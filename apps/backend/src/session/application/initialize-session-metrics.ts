import { SessionStatus } from "../domain/session-state.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionMetrics } from "../ports/session-metrics.js";
import type { SessionRetentionPolicies } from "../ports/session-retention-policies.js";

export class InitializeSessionMetrics {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "countSessionsForMaintenance"
        >,
        private readonly policies: SessionRetentionPolicies,
        private readonly metrics: Pick<SessionMetrics, "recordInitialCount">,
    ) {}

    async execute(): Promise<void> {
        for (const tenant of await this.policies.listForMaintenance()) {
            for (const status of Object.values(SessionStatus)) {
                for (const kind of ["issuance", "verification"] as const) {
                    const count =
                        await this.sessions.countSessionsForMaintenance(
                            tenant.tenantId,
                            kind,
                            status,
                        );
                    this.metrics.recordInitialCount(
                        tenant.tenantId,
                        kind,
                        status,
                        count,
                    );
                }
            }
        }
    }
}
