import type { ChangeSessionState } from "../../../session/application/change-session-state.js";
import type { SessionStore } from "../../../session/application/session-store.js";
import type { SessionData } from "../../../session/domain/session-data.js";
import type {
    SessionOutcome,
    SessionOutcomeCredential,
} from "../../../session/domain/session-outcome.js";
import { SessionStatus } from "../../../session/domain/session-state.js";
import type { WebhookConfiguration } from "../../../webhook/domain/webhook-configuration.js";
import type { PresentationResultPublisher } from "../../../webhook/ports/presentation-result-publisher.js";

export interface FailPresentationResponseInput {
    tenantId: string;
    sessionId: string;
    /** Classifies the session for metrics (verification sessions carry one). */
    requestId?: string | null;
    message: string;
    code?: string;
    /** Per-credential failure details for the outcome. */
    credentials?: SessionOutcomeCredential[];
    /** Reports the failure to this webhook (best effort, never with credentials). */
    publish?: { webhook: WebhookConfiguration; session: SessionData };
}

export interface FailPresentationResult {
    /** False when no session was updated (missing, finished or expired). */
    failed: boolean;
    /** Redirect override returned by the webhook, if any. */
    redirectUri?: string;
    publicationFailed: boolean;
    publicationError?: unknown;
}

/** Records a failed presentation, then reports it, preserving best-effort delivery. */
export class FailPresentationResponse {
    constructor(
        private readonly sessions: Pick<SessionStore, "updateIfUnconsumed">,
        private readonly state: Pick<ChangeSessionState, "announce">,
        private readonly publisher: PresentationResultPublisher,
    ) {}

    async execute(
        input: FailPresentationResponseInput,
    ): Promise<FailPresentationResult> {
        const outcome: SessionOutcome = {
            result: "failed",
            ...(input.code ? { error: input.code } : {}),
            message: input.message,
            ...(input.credentials?.length
                ? { credentials: input.credentials }
                : {}),
        };
        const update = {
            status: SessionStatus.Failed,
            errorReason: input.message,
            responseEncryptionPrivateJwk: null,
            ...(input.code ? { failureCode: input.code } : {}),
            outcome,
        };
        // Conditional like the completion: a session another response
        // completed, or one that expired meanwhile, keeps its final state.
        const failed = await this.sessions.updateIfUnconsumed(
            input.tenantId,
            input.sessionId,
            update,
        );
        if (!failed) {
            return { failed: false, publicationFailed: false };
        }
        this.state.announce(
            {
                id: input.sessionId,
                tenantId: input.tenantId,
                requestId: input.requestId,
            },
            SessionStatus.Failed,
        );

        if (!input.publish) {
            return { failed: true, publicationFailed: false };
        }
        try {
            const response = await this.publisher.publish({
                webhook: input.publish.webhook,
                session: input.publish.session,
                status: SessionStatus.Failed,
                outcome,
            });
            return {
                failed: true,
                redirectUri: response?.redirectUri || undefined,
                publicationFailed: false,
            };
        } catch (publicationError) {
            return { failed: true, publicationFailed: true, publicationError };
        }
    }
}
