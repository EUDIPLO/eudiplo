import type { SessionData } from "../../session/domain/session-data.js";
import type { SessionOutcome } from "../../session/domain/session-outcome.js";
import type { SessionStatus } from "../../session/domain/session-state.js";
import type { WebhookConfiguration } from "../domain/webhook-configuration.js";

export interface PresentationResult {
    redirectUri?: string;
}

/**
 * The terminal result of a presentation: the session's status and the
 * structured outcome persisted on it. Only a completed presentation carries
 * credentials.
 */
export type PresentationResultReport = { outcome: SessionOutcome } & (
    | {
          status: SessionStatus.Completed;
          credentials?: unknown[];
          rawPresentationPayload?: unknown;
      }
    | {
          /** Wallet error response (e.g. declined) or failed verification. */
          status: SessionStatus.Failed;
      }
);

export type PresentationResultPublication = PresentationResultReport & {
    webhook: WebhookConfiguration;
    session: SessionData;
};

export interface PresentationResultPublisher {
    publish(values: PresentationResultPublication): Promise<PresentationResult>;
}

export const PRESENTATION_RESULT_PUBLISHER = Symbol(
    "PRESENTATION_RESULT_PUBLISHER",
);
