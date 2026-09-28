import type { NewSession, SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import type { SessionMetrics } from "../ports/session-metrics.js";

export class CreateSession {
    constructor(
        private readonly sessions: Pick<SessionRepository, "create">,
        private readonly metrics: Pick<SessionMetrics, "recordCreated">,
    ) {}

    async execute(session: NewSession): Promise<SessionData> {
        const created = await this.sessions.create(session);
        this.metrics.recordCreated(created);
        return created;
    }
}
