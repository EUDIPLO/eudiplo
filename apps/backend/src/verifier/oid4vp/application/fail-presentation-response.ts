import type { SessionStore } from "../../../session/application/session-store.js";
import { SessionStatus } from "../../../session/domain/session-state.js";

export class FailPresentationResponse {
    constructor(
        private readonly sessions: Pick<SessionStore, "updateForTenant">,
    ) {}
    async execute(input: {
        tenantId: string;
        sessionId: string;
        message: string;
        code?: string;
    }) {
        await this.sessions.updateForTenant(input.tenantId, input.sessionId, {
            status: SessionStatus.Failed,
            errorReason: input.message,
            responseEncryptionPrivateJwk: null,
            ...(input.code ? { failureCode: input.code } : {}),
            outcome: {
                result: "failed",
                ...(input.code ? { error: input.code } : {}),
                message: input.message,
            },
        });
    }
}
