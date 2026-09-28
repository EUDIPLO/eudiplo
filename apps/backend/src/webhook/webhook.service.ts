import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { firstValueFrom } from "rxjs";
import { SessionStore } from "../session/application/session-store.js";
import type {
    Notification,
    SessionData as Session,
} from "../session/domain/session-data.js";
import { OutboundUrlPolicyService } from "./outbound-url-policy.service.js";
import { WebhookConfig } from "./webhook.dto.js";
import { extractRawTokenFromSubmission } from "./webhook.utils.js";

/**
 * Response from a webhook to receive credentials.
 * Can include claims data for immediate issuance or a deferred flag for deferred issuance.
 */
export interface WebhookResponse {
    /**
     * Redirect URI for OAuth-style redirects.
     */
    redirectUri?: string;
    /**
     * When true, indicates that the credential issuance should be deferred.
     * The wallet will receive a transaction_id to poll later.
     */
    deferred?: boolean;
    /**
     * Recommended polling interval in seconds for deferred issuance.
     * Defaults to 5 seconds if not specified.
     */
    interval?: number;
    /**
     * Claims data keyed by credential configuration ID.
     * Allows dynamic keys for credential configuration IDs.
     */
    [credentialConfigurationId: string]:
        | Record<string, any>
        | string
        | boolean
        | number
        | undefined;
}

/**
 * Service for handling webhooks in the application.
 * HTTP calls are auto-instrumented by OpenTelemetry for distributed tracing.
 */
@Injectable()
export class WebhookService {
    constructor(
        private readonly httpService: HttpService,
        private readonly sessionStore: SessionStore,
        private readonly outboundUrlPolicyService: OutboundUrlPolicyService,
        private readonly logger: PinoLogger,
    ) {
        this.logger.setContext("WebhookService");
    }

    /**
     * Sends a webhook with the optional provided credentials, return the response data.
     * @returns WebhookResponse containing claims data or deferred issuance indicator
     */
    sendWebhook(values: {
        webhook: WebhookConfig;
        session: Session;
        credentials?: any[];
        expectResponse: boolean;
        rawPresentationPayload?: any;
    }): Promise<WebhookResponse> {
        return this.outboundUrlPolicyService
            .assertSafeUrl(values.webhook.url)
            .then(() => this.sendWebhookInternal(values));
    }

    private sendWebhookInternal(values: {
        webhook: WebhookConfig;
        session: Session;
        credentials?: any[];
        expectResponse: boolean;
        rawPresentationPayload?: any;
    }): Promise<WebhookResponse> {
        const headers: Record<string, string> = {};

        if (values.webhook.auth && values.webhook.auth.type === "apiKey") {
            headers[values.webhook.auth.config.headerName] =
                values.webhook.auth.config.value;
        }

        let payloadCredentials = values.credentials;

        if (
            payloadCredentials &&
            values.webhook.includeRawTokensFor?.length &&
            values.rawPresentationPayload
        ) {
            const requestedIds = values.webhook.includeRawTokensFor;
            const rawPayload = values.rawPresentationPayload;

            payloadCredentials = payloadCredentials.map((cred) => {
                if (requestedIds.includes(cred.id)) {
                    const rawToken = extractRawTokenFromSubmission(
                        cred.id,
                        rawPayload,
                    );
                    return {
                        ...cred,
                        rawToken,
                    };
                }
                return cred;
            });
        }

        this.logger.debug(
            { webhookUrl: values.webhook.url, sessionId: values.session.id },
            "Sending webhook",
        );

        return firstValueFrom(
            this.httpService.post(
                values.webhook.url,
                {
                    credentials: payloadCredentials,
                    session: values.session.id,
                    transaction_data: values.session.transaction_data,
                },
                {
                    headers,
                    lookup: this.outboundUrlPolicyService.safeLookup as never,
                },
            ),
        ).then(
            async (webhookResponse) => {
                if (webhookResponse.data?.redirectUri) {
                    // redirectUri is returned but no special handling needed here
                } else if (webhookResponse.data && values.expectResponse) {
                    await this.sessionStore.updateForTenant(
                        values.session.tenantId,
                        values.session.id,
                        {
                            credentialPayload: values.session.credentialPayload,
                        },
                    );
                }

                return webhookResponse.data;
            },
            (err) => {
                this.logger.error(
                    { webhookUrl: values.webhook.url, error: err.message },
                    "Error sending webhook",
                );
                throw new Error(`Error sending webhook: ${err.message || err}`);
            },
        );
    }

    /**
     * Sends a webhook notification for a session.
     * @param webhook The webhook configuration
     * @param session The session
     * @param notification The notification payload
     */
    async sendWebhookNotification(
        webhook: WebhookConfig,
        session: Session,
        notification: Notification,
    ) {
        await this.outboundUrlPolicyService.assertSafeUrl(webhook.url);

        const headers: Record<string, string> = {};

        if (webhook.auth && webhook.auth.type === "apiKey") {
            headers[webhook.auth.config.headerName] = webhook.auth.config.value;
        }

        this.logger.debug(
            { webhookUrl: webhook.url, sessionId: session.id },
            "Sending webhook notification",
        );

        await firstValueFrom(
            this.httpService.post(
                webhook.url,
                {
                    notification,
                    session: session.id,
                },
                {
                    headers,
                    lookup: this.outboundUrlPolicyService.safeLookup as never,
                },
            ),
        ).then(
            () => {
                // Success - OTel traces capture the HTTP call details
            },
            (err) => {
                this.logger.error(
                    { webhookUrl: webhook.url, error: err.message },
                    "Error sending webhook notification",
                );
                throw new Error(`Error sending webhook: ${err.message || err}`);
            },
        );
    }

    /**
     * Unified webhook for fetching claims.
     * Sends a consistent payload regardless of AS type (internal or external).
     *
     * @param values.webhook The webhook configuration
     * @param values.session The session ID
     * @param values.credentialConfigurationId The credential configuration being requested
     * @param values.identity Optional identity context from authorization
     * @param values.credentials Optional presented credentials (for presentation flows)
     * @returns WebhookResponse containing claims data or deferred issuance indicator
     */
    async sendClaimsWebhook(values: {
        webhook: WebhookConfig;
        session: string;
        credentialConfigurationId: string;
        identity?: {
            iss: string;
            sub: string;
            token_claims: Record<string, unknown>;
        };
        credentials?: any[];
    }): Promise<WebhookResponse> {
        await this.outboundUrlPolicyService.assertSafeUrl(values.webhook.url);

        const headers: Record<string, string> = {};

        if (values.webhook.auth?.type === "apiKey") {
            headers[values.webhook.auth.config.headerName] =
                values.webhook.auth.config.value;
        }

        this.logger.debug(
            {
                webhookUrl: values.webhook.url,
                sessionId: values.session,
                credentialConfigurationId: values.credentialConfigurationId,
            },
            "Sending claims webhook",
        );

        const payload: Record<string, unknown> = {
            session: values.session,
            credential_configuration_id: values.credentialConfigurationId,
        };

        if (values.identity) {
            payload.identity = values.identity;
        }

        if (values.credentials?.length) {
            payload.credentials = values.credentials;
        }

        return firstValueFrom(
            this.httpService.post(values.webhook.url, payload, {
                headers,
                lookup: this.outboundUrlPolicyService.safeLookup as never,
            }),
        ).then(
            (webhookResponse) => {
                return webhookResponse.data;
            },
            (err) => {
                this.logger.error(
                    { webhookUrl: values.webhook.url, error: err.message },
                    "Error sending claims webhook",
                );
                throw new Error(
                    `Error sending claims webhook: ${err.message || err}`,
                );
            },
        );
    }
}
