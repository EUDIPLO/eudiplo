import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";

export class GetSessionByAuthorizationCode {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "findByAuthorizationCode"
        >,
    ) {}

    async execute(
        tenantId: string,
        authorizationCode: string | undefined,
    ): Promise<SessionData> {
        if (!authorizationCode) throw new SessionNotFound();
        const session = await this.sessions.findByAuthorizationCode(
            tenantId,
            authorizationCode,
        );
        if (!session) throw new SessionNotFound();
        return session;
    }
}
