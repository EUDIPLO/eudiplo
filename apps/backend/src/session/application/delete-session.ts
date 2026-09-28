import type { SessionRepository } from "../ports/session.repository.js";

export class DeleteSession {
    constructor(
        private readonly sessions: Pick<SessionRepository, "deleteForTenant">,
    ) {}

    execute(tenantId: string, sessionId: string): Promise<void> {
        return this.sessions.deleteForTenant(tenantId, sessionId);
    }
}
