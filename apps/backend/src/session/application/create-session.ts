import type { NewSession, SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import {
    NO_SESSION_CONTEXT,
    type SessionContext,
} from "../ports/session-context.js";

export class CreateSession {
    constructor(
        private readonly sessions: Pick<SessionRepository, "create">,
        private readonly context: SessionContext = NO_SESSION_CONTEXT,
    ) {}

    async execute(session: NewSession): Promise<SessionData> {
        const created = await this.sessions.create(session);
        this.context.bind(created);
        return created;
    }
}
