import type { NewSession, SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";

export class CreateSession {
    constructor(private readonly sessions: Pick<SessionRepository, "create">) {}

    execute(session: NewSession): Promise<SessionData> {
        return this.sessions.create(session);
    }
}
