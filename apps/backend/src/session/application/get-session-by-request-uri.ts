import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";

export class GetSessionByRequestUri {
    constructor(
        private readonly sessions: Pick<SessionRepository, "findByRequestUri">,
    ) {}

    async execute(tenantId: string, requestUri: string): Promise<SessionData> {
        const session = await this.sessions.findByRequestUri(
            tenantId,
            requestUri,
        );
        if (!session) throw new SessionNotFound();
        return session;
    }
}
