import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import {
    AxiosError,
    type AxiosRequestConfig,
    type AxiosResponse,
    isAxiosError,
} from "axios";
import { PinoLogger } from "nestjs-pino";
import { firstValueFrom } from "rxjs";
import { SessionStore } from "../session/application/session-store.js";
import type {
    Notification,
    SessionData as Session,
} from "../session/domain/session-data.js";
import type { SessionOutcome } from "../session/domain/session-outcome.js";
import { SessionStatus } from "../session/domain/session-state.js";
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
 * Terminal status and structured outcome of a presentation, sent with every
 * presentation webhook (`completed` with credentials, `failed` without).
 */
interface PresentationWebhookResult {
    status: string;
    outcome: SessionOutcome;
}

/**
 * Limits for every webhook delivery, redirects included. Webhooks often
 * answer within a wallet's request, so a receiver that never finishes must
 * not hold it open, and the response is buffered in memory.
 */
const WEBHOOK_TIMEOUT_MS = 60_000;
const WEBHOOK_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const WEBHOOK_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The caller reference of the session, only when one was set. */
function referenceOf(session: { reference?: string | null }) {
    return session.reference ? { reference: session.reference } : {};
}

/** The API key header of the webhook, when it uses one. */
function authHeaders(webhook: WebhookConfig): Record<string, string> {
    return webhook.auth?.type === "apiKey"
        ? { [webhook.auth.config.headerName]: webhook.auth.config.value }
        : {};
}

/**
 * A redirect that is not followed. The message never contains the target,
 * which only the log shows.
 */
class WebhookRedirectError extends Error {
    constructor(
        message: string,
        readonly redirectTarget?: string,
    ) {
        super(message);
    }
}

/**
 * Why a delivery failed, in words that may reach a wallet: the message of a
 * claims webhook error ends up in its error response. Network errors name
 * hosts and addresses, so they are only described here; the log keeps them.
 */
function deliveryError(err: unknown): string {
    if (err instanceof WebhookRedirectError) return err.message;
    if (isAxiosError(err)) {
        // Only the deadline signal of deliver() cancels a delivery.
        if (err.code === AxiosError.ERR_CANCELED) {
            return `the webhook did not answer within ${WEBHOOK_TIMEOUT_MS / 1000} seconds`;
        }
        if (err.message.startsWith("maxContentLength")) {
            return `the webhook answer exceeds ${WEBHOOK_MAX_RESPONSE_BYTES / 1024 / 1024} MiB`;
        }
        if (err.response) {
            return `the webhook answered with HTTP ${err.response.status}`;
        }
    }
    return "the webhook could not be reached";
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
     * POSTs to a webhook whose URL passed the outbound URL policy. Redirects
     * are followed here instead of by axios, so that every target passes the
     * policy as well: 307 and 308 repeat the POST, the others continue with a
     * GET without body. The API key header only goes to the webhook's own
     * origin.
     */
    private async deliver(
        webhook: WebhookConfig,
        payload: unknown,
    ): Promise<AxiosResponse> {
        const origin = new URL(webhook.url).origin;
        // One deadline for all hops, body included; axios' `timeout` would
        // end when the response headers arrive.
        const signal = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
        let url = webhook.url;
        let post = true;
        for (let redirects = 0; ; redirects++) {
            const options: AxiosRequestConfig = {
                headers:
                    new URL(url).origin === origin ? authHeaders(webhook) : {},
                lookup: this.outboundUrlPolicyService.safeLookup as never,
                // No connection pooling, so safeLookup checks every connection
                // instead of a socket opened by an earlier request being reused.
                httpAgent: false,
                httpsAgent: false,
                maxRedirects: 0,
                signal,
                maxContentLength: WEBHOOK_MAX_RESPONSE_BYTES,
                validateStatus: (status) =>
                    (status >= 200 && status < 300) ||
                    REDIRECT_STATUSES.has(status),
            };
            const response: AxiosResponse = await firstValueFrom(
                post
                    ? this.httpService.post(url, payload, options)
                    : this.httpService.get(url, options),
            );
            if (!REDIRECT_STATUSES.has(response.status)) return response;

            const location = response.headers?.location;
            if (typeof location !== "string") {
                throw new WebhookRedirectError(
                    `the webhook answered with a redirect (HTTP ${response.status}) without a location`,
                );
            }
            const target = URL.parse(location, url)?.toString();
            if (target === undefined) {
                throw new WebhookRedirectError(
                    "the webhook redirected to an invalid location",
                    location,
                );
            }
            if (redirects === WEBHOOK_MAX_REDIRECTS) {
                throw new WebhookRedirectError(
                    `the webhook redirected more than ${WEBHOOK_MAX_REDIRECTS} times`,
                    target,
                );
            }
            await this.outboundUrlPolicyService
                .assertSafeUrl(target)
                .catch((error: Error) => {
                    throw new WebhookRedirectError(
                        `the webhook redirected to a URL that the outbound URL policy blocks: ${error.message}`,
                        target,
                    );
                });
            url = target;
            post &&= response.status === 307 || response.status === 308;
        }
    }

    /** Logs a failed delivery and returns the error to throw. */
    private deliveryFailure(
        err: unknown,
        webhookUrl: string,
        description: string,
        errorPrefix: string,
    ): Error {
        this.logger.error(
            {
                webhookUrl,
                error: err instanceof Error ? err.message : String(err),
                ...(err instanceof WebhookRedirectError && err.redirectTarget
                    ? { redirectTarget: err.redirectTarget }
                    : {}),
            },
            `Error sending ${description}`,
        );
        return new Error(`${errorPrefix}: ${deliveryError(err)}`);
    }

    /**
     * Sends a webhook with the optional provided credentials, return the response data.
     * Presentation results pass `result`, which adds `status` and `outcome`.
     * @returns WebhookResponse containing claims data or deferred issuance indicator
     */
    sendWebhook(values: {
        webhook: WebhookConfig;
        session: Session;
        credentials?: any[];
        expectResponse: boolean;
        rawPresentationPayload?: any;
        result?: PresentationWebhookResult;
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
        result?: PresentationWebhookResult;
    }): Promise<WebhookResponse> {
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

        return this.deliver(values.webhook, {
            ...(values.result
                ? {
                      status: values.result.status,
                      outcome: values.result.outcome,
                  }
                : {}),
            credentials: payloadCredentials,
            session: values.session.id,
            ...referenceOf(values.session),
            transaction_data: values.session.transaction_data,
        }).then(
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
                throw this.deliveryFailure(
                    err,
                    values.webhook.url,
                    "webhook",
                    "Error sending webhook",
                );
            },
        );
    }

    /**
     * Sends a webhook notification for a session.
     * @param webhook The webhook configuration
     * @param session The session
     * @param notification The notification payload
     */
    sendWebhookNotification(
        webhook: WebhookConfig,
        session: Session,
        notification: Notification,
    ) {
        return this.postSessionEvent(
            webhook,
            session,
            { notification, session: session.id, ...referenceOf(session) },
            "webhook notification",
        );
    }

    /**
     * Tells the session webhook that an operator cancelled the offer, with
     * `status: "cancelled"` like the status of a presentation result.
     * @param webhook The webhook configuration
     * @param session The cancelled session
     * @param reason Why the offer was cancelled, when given
     */
    sendSessionCancelledWebhook(
        webhook: WebhookConfig,
        session: Session,
        reason?: string,
    ) {
        return this.postSessionEvent(
            webhook,
            session,
            {
                status: SessionStatus.Cancelled,
                session: session.id,
                ...referenceOf(session),
                ...(reason ? { reason } : {}),
            },
            "session cancelled webhook",
        );
    }

    /**
     * Posts a session event whose response body is ignored.
     * @throws Error when the URL is blocked or the delivery failed
     */
    private async postSessionEvent(
        webhook: WebhookConfig,
        session: Session,
        payload: Record<string, unknown>,
        description: string,
    ): Promise<void> {
        await this.outboundUrlPolicyService.assertSafeUrl(webhook.url);

        this.logger.debug(
            { webhookUrl: webhook.url, sessionId: session.id },
            `Sending ${description}`,
        );

        await this.deliver(webhook, payload).catch((err) => {
            throw this.deliveryFailure(
                err,
                webhook.url,
                description,
                "Error sending webhook",
            );
        });
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
        reference?: string;
        credentialConfigurationId: string;
        identity?: {
            iss: string;
            sub: string;
            token_claims: Record<string, unknown>;
        };
        credentials?: any[];
    }): Promise<WebhookResponse> {
        await this.outboundUrlPolicyService.assertSafeUrl(values.webhook.url);

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
            ...(values.reference ? { reference: values.reference } : {}),
            credential_configuration_id: values.credentialConfigurationId,
        };

        if (values.identity) {
            payload.identity = values.identity;
        }

        if (values.credentials?.length) {
            payload.credentials = values.credentials;
        }

        return this.deliver(values.webhook, payload).then(
            (webhookResponse) => {
                return webhookResponse.data;
            },
            (err) => {
                throw this.deliveryFailure(
                    err,
                    values.webhook.url,
                    "claims webhook",
                    "Error sending claims webhook",
                );
            },
        );
    }
}
