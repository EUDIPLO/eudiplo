import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";

export class GetSessionForInternalFlow {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "findByIdForInternalFlow"
        >,
    ) {}

    async execute(sessionId: string): Promise<SessionData> {
        const session = await this.sessions.findByIdForInternalFlow(sessionId);
        if (!session) throw new SessionNotFound();
        return session;
    }
}
