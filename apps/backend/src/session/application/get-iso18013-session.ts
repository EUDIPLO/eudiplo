import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";

export class GetIso18013Session {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "findIso18013Session"
        >,
    ) {}

    async execute(sessionId: string): Promise<SessionData> {
        const session = await this.sessions.findIso18013Session(sessionId);
        if (!session) throw new SessionNotFound();
        return session;
    }
}
