import type { SessionUpdate } from "../domain/session-data.js";
import type { SessionRepository } from "../ports/session.repository.js";

/** Single-use completion: only the first caller may update an unconsumed session. */
export class UpdateUnconsumedSession {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "updateUnconsumedForTenant"
        >,
    ) {}

    execute(
        tenantId: string,
        sessionId: string,
        update: SessionUpdate,
    ): Promise<boolean> {
        return this.sessions.updateUnconsumedForTenant(
            tenantId,
            sessionId,
            update,
        );
    }
}
