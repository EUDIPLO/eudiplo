import type { ChangeSessionState } from "../../../session/application/change-session-state.js";
import type { SessionStore } from "../../../session/application/session-store.js";
import type { SessionOutcome } from "../../../session/domain/session-outcome.js";
import { SessionStatus } from "../../../session/domain/session-state.js";

export interface CompletePresentationResponseInput {
    tenantId: string;
    sessionId: string;
    /** Classifies the session for metrics (verification sessions carry one). */
    requestId?: string | null;
    credentials: unknown[];
    responseCode: string;
    consumedAt?: Date;
}

/** Another response already completed this presentation request (replay). */
export class PresentationAlreadyConsumed extends Error {
    constructor() {
        super("The presentation offer has already been used");
        this.name = "PresentationAlreadyConsumed";
    }
}

export class CompletePresentationResponse {
    constructor(
        private readonly sessions: Pick<SessionStore, "updateIfUnconsumed">,
        private readonly state: Pick<ChangeSessionState, "announce">,
    ) {}

    /**
     * Completes the session atomically with its single-use flag, so concurrent
     * responses for the same request cannot both succeed. Only the winning
     * call publishes the status event and records metrics.
     * @returns the outcome persisted on the session
     * @throws PresentationAlreadyConsumed when another response won
     */
    async execute(
        input: CompletePresentationResponseInput,
    ): Promise<SessionOutcome> {
        const outcome: SessionOutcome = {
            result: "success",
            credentials: input.credentials.map((credential: any) => ({
                id:
                    typeof credential?.id === "string"
                        ? credential.id
                        : undefined,
                verified: true,
            })),
        };
        const completed = await this.sessions.updateIfUnconsumed(
            input.tenantId,
            input.sessionId,
            {
                credentials: input.credentials as any,
                status: SessionStatus.Completed,
                responseCode: input.responseCode,
                consumed: true,
                consumedAt: input.consumedAt ?? new Date(),
                responseEncryptionPrivateJwk: null,
                outcome,
            },
        );
        if (!completed) throw new PresentationAlreadyConsumed();
        this.state.announce(
            {
                id: input.sessionId,
                tenantId: input.tenantId,
                requestId: input.requestId,
            },
            SessionStatus.Completed,
        );
        return outcome;
    }
}
