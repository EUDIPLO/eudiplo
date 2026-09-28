import type { SessionData } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";
import { SessionNotFound } from "./session-errors.js";

export class GetSessionByRefreshToken {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "findByRefreshToken"
        >,
    ) {}

    async execute(
        tenantId: string,
        refreshToken: string,
    ): Promise<SessionData> {
        const session = await this.sessions.findByRefreshToken(
            tenantId,
            refreshToken,
        );
        if (!session) throw new SessionNotFound();
        return session;
    }
}
