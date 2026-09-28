import type { SessionRepository } from "../ports/session.repository.js";

export class SessionAttemptTargetNotFound extends Error {
    constructor() {
        super("Session for failed transaction-code attempt was not found");
        this.name = "SessionAttemptTargetNotFound";
    }
}

/** Records a rejected transaction code and evaluates the configured lockout limit. */
export class RecordFailedTxCodeAttempt {
    constructor(
        private readonly sessions: Pick<
            SessionRepository,
            "incrementFailedTxCodeAttempts"
        >,
    ) {}

    async execute(tenantId: string, sessionId: string, maxAttempts = 5) {
        const failedAttempts =
            await this.sessions.incrementFailedTxCodeAttempts(
                tenantId,
                sessionId,
            );
        if (failedAttempts === null) throw new SessionAttemptTargetNotFound();
        return { failedAttempts, locked: failedAttempts >= maxAttempts };
    }
}
