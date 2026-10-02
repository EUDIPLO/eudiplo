import type { ChangeSessionState } from "../../../session/application/change-session-state.js";
import type { SessionStore } from "../../../session/application/session-store.js";
import { SessionStatus } from "../../../session/domain/session-state.js";

export class FailPresentationResponse {
    constructor(
        private readonly sessions: Pick<SessionStore, "updateIfUnconsumed">,
        private readonly state: Pick<ChangeSessionState, "announce">,
    ) {}
    async execute(input: {
        tenantId: string;
        sessionId: string;
        /** Classifies the session for metrics (verification sessions carry one). */
        requestId?: string | null;
        message: string;
        code?: string;
    }) {
        // Conditional like the completion: a session another response
        // completed, or one that expired meanwhile, keeps its final state.
        const updated = await this.sessions.updateIfUnconsumed(
            input.tenantId,
            input.sessionId,
            {
                status: SessionStatus.Failed,
                errorReason: input.message,
                responseEncryptionPrivateJwk: null,
                ...(input.code ? { failureCode: input.code } : {}),
                outcome: {
                    result: "failed",
                    ...(input.code ? { error: input.code } : {}),
                    message: input.message,
                },
            },
        );
        if (updated) {
            this.state.announce(
                {
                    id: input.sessionId,
                    tenantId: input.tenantId,
                    requestId: input.requestId,
                },
                SessionStatus.Failed,
            );
        }
    }
}
