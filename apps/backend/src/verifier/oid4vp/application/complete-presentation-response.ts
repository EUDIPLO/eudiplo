import type { UpdateUnconsumedSession } from "../../../session/application/update-unconsumed-session.js";
import { SessionStatus } from "../../../session/domain/session-state.js";

export interface CompletePresentationResponseInput {
    tenantId: string;
    sessionId: string;
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
        private readonly updateSession: Pick<
            UpdateUnconsumedSession,
            "execute"
        >,
    ) {}

    /**
     * Completes the session atomically with its single-use flag, so concurrent
     * responses for the same request cannot both succeed.
     * @throws PresentationAlreadyConsumed when another response won
     */
    async execute(input: CompletePresentationResponseInput): Promise<void> {
        const completed = await this.updateSession.execute(
            input.tenantId,
            input.sessionId,
            {
                credentials: input.credentials as any,
                status: SessionStatus.Completed,
                responseCode: input.responseCode,
                consumed: true,
                consumedAt: input.consumedAt ?? new Date(),
                responseEncryptionPrivateJwk: null,
                outcome: {
                    result: "success",
                    credentials: input.credentials.map((credential: any) => ({
                        id:
                            typeof credential?.id === "string"
                                ? credential.id
                                : undefined,
                        verified: true,
                    })),
                },
            },
        );
        if (!completed) throw new PresentationAlreadyConsumed();
    }
}
