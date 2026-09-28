import type { SessionData } from "../../session/domain/session-data.js";
import type { WebhookConfiguration } from "../domain/webhook-configuration.js";

export interface PresentationResult {
    redirectUri?: string;
}

export interface PresentationResultPublisher {
    publish(values: {
        webhook: WebhookConfiguration;
        session: SessionData;
        credentials?: unknown[];
        rawPresentationPayload?: unknown;
    }): Promise<PresentationResult>;
}

export const PRESENTATION_RESULT_PUBLISHER = Symbol(
    "PRESENTATION_RESULT_PUBLISHER",
);
