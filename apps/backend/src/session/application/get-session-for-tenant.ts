import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";

export class GetSessionForTenant {
    constructor(
        private readonly sessions: Pick<SessionRepository, "findForTenant">,
    ) {}

    async execute(
        tenantId: string,
        sessionId: string | undefined,
    ): Promise<SessionData> {
        if (!sessionId) throw new SessionNotFound();

        const session = await this.sessions.findForTenant(tenantId, sessionId);
        if (!session) throw new SessionNotFound();
        return session;
    }
}
