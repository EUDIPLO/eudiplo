import type { SessionUpdate } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";

export class UpdateSessionForTenant {
    constructor(
        private readonly sessions: Pick<SessionRepository, "updateForTenant">,
    ) {}

    execute(tenantId: string, sessionId: string, update: SessionUpdate) {
        return this.sessions.updateForTenant(tenantId, sessionId, update);
    }
}
