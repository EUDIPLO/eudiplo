import type { SessionData } from "../../../session/domain/session-data.js";
import type { WebhookConfiguration } from "../../../webhook/domain/webhook-configuration.js";
import type { PresentationResultPublisher } from "../../../webhook/ports/presentation-result-publisher.js";
import type { AuthResponseData } from "../../presentations/domain/auth-response.js";
import type { CompletePresentationResponse } from "./complete-presentation-response.js";
import type { ParseAuthorizationResponse } from "./parse-authorization-response.js";

/** Completes verified responses before publishing, preserving best-effort delivery. */
export class ProcessVerifiedPresentation {
    constructor(
        private readonly state: Pick<
            ParseAuthorizationResponse,
            "validateState"
        >,
        private readonly complete: Pick<
            CompletePresentationResponse,
            "execute"
        >,
        private readonly publisher: PresentationResultPublisher,
    ) {}
    async execute(input: {
        response: AuthResponseData;
        session: SessionData;
        credentials?: unknown[];
        responseCode: string;
        webhook?: WebhookConfiguration;
        rawPresentationPayload?: unknown;
    }): Promise<{
        redirectUri?: string | null;
        publicationFailed: boolean;
        publicationError?: unknown;
    }> {
        const { session } = input;
        this.state.validateState(
            input.response,
            session.walletNonce ?? session.id,
        );
        await this.complete.execute({
            tenantId: session.tenantId,
            sessionId: session.id,
            credentials: input.credentials ?? [],
            responseCode: input.responseCode,
        });
        if (input.webhook) {
            try {
                const response = await this.publisher.publish({
                    webhook: input.webhook,
                    session,
                    credentials: input.credentials,
                    rawPresentationPayload: input.rawPresentationPayload,
                });
                return {
                    redirectUri: response?.redirectUri || session.redirectUri,
                    publicationFailed: false,
                };
            } catch (publicationError) {
                return {
                    redirectUri: session.redirectUri,
                    publicationFailed: true,
                    publicationError,
                };
            }
        }
        return { redirectUri: session.redirectUri, publicationFailed: false };
    }
}
