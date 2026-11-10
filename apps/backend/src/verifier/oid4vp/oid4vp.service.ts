import { randomUUID } from "node:crypto";
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
    type Openid4vpAuthorizationErrorResponse,
    zOpenid4vpAuthorizationErrorResponse,
} from "@openid4vc/openid4vp";
import { base64url, type JWK } from "jose";
import { Span, TraceService } from "nestjs-otel";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { EncryptedResponseRejectedError } from "../../crypto/encryption/encrypted-response-rejected.error.js";
import { EncryptionService } from "../../crypto/encryption/encryption.service.js";
import { CertService } from "../../crypto/key/cert/cert.service.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { WebhookEndpointEntity } from "../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { OfferResponse } from "../../issuer/issuance/oid4vci/dto/offer-request.dto.js";
import { CreateSession } from "../../session/application/create-session.js";
import { SessionStore } from "../../session/application/session-store.js";
import type { SessionData } from "../../session/domain/session-data.js";
import type { SessionOutcomeCredential } from "../../session/domain/session-outcome.js";
import {
    assertSessionUsable,
    SessionNotUsable,
} from "../../session/domain/session-usability.js";
import { AuditLogContext } from "../../session/logging/session-audit.service.js";
import { SessionLoggerService } from "../../session/logging/session-logger.service.js";
import { DEFAULT_VERIFIER_SKEW_SECONDS } from "../../trust/types.js";
import type { WebhookConfiguration } from "../../webhook/domain/webhook-configuration.js";
import {
    CredentialVerificationFailedError,
    IncompletePresentationError,
    MultiplePresentationsNotAllowedError,
    type PresentationQuery,
    UnknownPresentedCredentialError,
    type VerifiedPresentation,
    VerifyPresentationResponse,
} from "../presentations/application/verify-presentation-response.js";
import { allowedExpectedOrigin } from "../presentations/configuration/allowed-expected-origin.js";
import { PresentationConfigService } from "../presentations/configuration/presentation-config.service.js";
import { PresentationRegistrationCertificateService } from "../presentations/configuration/presentation-registration-certificate.service.js";
import { verificationFailureDetails } from "../presentations/credential/verification-failure.js";
import type { AuthResponseData } from "../presentations/domain/auth-response.js";
import { UnsupportedCredentialVerifierFormat } from "../presentations/domain/credential-verifier-format.js";
import { UnknownClaimSetReferenceError } from "../presentations/domain/dcql-claim-policy.js";
import { resolveDcqlTenantUrl } from "../presentations/domain/dcql-tenant-url.js";
import { TransactionDataBindingError } from "../presentations/domain/transaction-data-binding.js";
import { IncompletePresentationException } from "../presentations/exceptions/incomplete-presentation.exception.js";
import { InvalidTrustedAuthoritiesError } from "../presentations/ports/trust-list-ref-resolver.js";
import { TrustedAuthoritiesService } from "../presentations/trusted-authorities.service.js";
import { PresentationAlreadyConsumed } from "./application/complete-presentation-response.js";
import { FailPresentationResponse } from "./application/fail-presentation-response.js";
import {
    ParseAuthorizationResponse,
    PresentationResponseValidationError,
} from "./application/parse-authorization-response.js";
import { ProcessVerifiedPresentation } from "./application/process-verified-presentation.js";
import { RetrievePresentationRequest } from "./application/retrieve-presentation-request.js";
import {
    createClientId,
    federationClientId,
    isFederationClientId,
} from "./client-id.util.js";
import { applyTrustedAuthoritiesPolicy } from "./dcql-trusted-authorities.util.js";
import { presentationRequestState } from "./domain/presentation-request-state.js";
import { AuthorizationResponse } from "./dto/authorization-response.dto.js";
import {
    ClientIdScheme,
    PresentationRequestOptions,
} from "./dto/presentation-request.dto.js";
import { OID4VP_SETTINGS, type Oid4vpSettings } from "./oid4vp-settings.js";
import {
    VERIFIER_FEDERATION_IDENTITY,
    type VerifierFederationIdentity,
} from "./ports/verifier-federation-identity.js";
import {
    ENCRYPTED_RESPONSE_ENC_VALUES_SUPPORTED,
    VerifierMetadataService,
} from "./verifier-metadata.service.js";

@Injectable()
export class Oid4vpService {
    constructor(
        @InjectPinoLogger(Oid4vpService.name)
        private readonly logger: PinoLogger,
        private readonly certService: CertService,
        public readonly keyChainService: KeyChainService,
        private readonly encryptionService: EncryptionService,
        private readonly verifyPresentationResponse: VerifyPresentationResponse,
        private readonly presentationConfigService: PresentationConfigService,
        private readonly registrationCertificateService: PresentationRegistrationCertificateService,
        private readonly trustedAuthoritiesService: TrustedAuthoritiesService,
        private readonly createSession: CreateSession,
        private readonly sessionStore: SessionStore,
        private readonly retrievePresentationRequest: RetrievePresentationRequest,
        private readonly parseAuthorizationResponse: ParseAuthorizationResponse,
        private readonly processVerifiedPresentation: ProcessVerifiedPresentation,
        private readonly failPresentationResponse: FailPresentationResponse,
        @Inject(OID4VP_SETTINGS)
        private readonly settings: Oid4vpSettings,
        private readonly auditLogger: SessionLoggerService,
        @InjectRepository(WebhookEndpointEntity)
        private readonly webhookEndpointRepo: Repository<WebhookEndpointEntity>,
        private readonly traceService: TraceService,
        private readonly verifierMetadata: VerifierMetadataService,
        @Inject(VERIFIER_FEDERATION_IDENTITY)
        private readonly federationIdentity: VerifierFederationIdentity,
    ) {}

    private async resolveWebhookFromEndpoint(
        webhookEndpointId: string | null | undefined,
        tenantId: string,
    ) {
        if (!webhookEndpointId) {
            return undefined;
        }

        const endpoint = await this.webhookEndpointRepo.findOneBy({
            id: webhookEndpointId,
            tenantId,
        });

        if (!endpoint) {
            this.logger.warn(
                { tenantId, webhookEndpointId },
                "Webhook endpoint configured on presentation config was not found",
            );
            return undefined;
        }

        return { url: endpoint.url, auth: endpoint.auth };
    }

    /**
     * Resolves the presentation webhook for a failure outside the verification
     * flow, with the same precedence as in getResponse. Best effort: a lookup
     * error must not change how the failure is recorded.
     */
    private async resolveFailureWebhook(
        session: SessionData,
    ): Promise<WebhookConfiguration | undefined> {
        if (session.parsedWebhook) {
            return session.parsedWebhook;
        }
        try {
            const webhookEndpointId =
                session.webhookEndpointId ??
                (session.requestId
                    ? (
                          await this.presentationConfigService.getPresentationConfig(
                              session.requestId,
                              session.tenantId,
                          )
                      ).webhookEndpointId
                    : undefined);
            return await this.resolveWebhookFromEndpoint(
                webhookEndpointId,
                session.tenantId,
            );
        } catch (error) {
            this.logger.warn(
                {
                    sessionId: session.id,
                    errorMessage: (error as Error)?.message,
                },
                "Could not resolve the webhook for a failed presentation",
            );
            return undefined;
        }
    }

    /**
     * Resolves a session from a wallet-facing nonce.
     * Per OID4VP spec Section 13.3, wallet-facing URLs use a separate walletNonce
     * instead of the session ID, which is never accepted in its place.
     */
    private async resolveSessionByNonce(nonce: string) {
        return this.sessionStore.getForWalletRequest(nonce);
    }

    /**
     * Gets the authorization request for a session.
     * Returns the cached requestObject if available (for request_uri_method="get"),
     * otherwise generates a new one.
     *
     * This ensures the wallet receives the exact same JWT that was stored during
     * session creation, which is essential for transaction_data hash validation.
     */
    @Span("oid4vp.getAuthorizationRequest")
    async getAuthorizationRequest(
        nonce: string,
        noRedirect = false,
    ): Promise<string> {
        const session = await this.resolveSessionByNonce(nonce);

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "session.requestId": session.requestId ?? "",
            "oid4vp.cached": !!session.requestObject,
        });

        return this.retrievePresentationRequest
            .execute(session, noRedirect, (sessionId, shouldNotRedirect) =>
                this.createAuthorizationRequest(sessionId, shouldNotRedirect),
            )
            .catch((error: unknown) => {
                throw sessionNotUsableException(error);
            });
    }

    /**
     * Creates an authorization request for a session.
     * @returns
     */
    @Span("oid4vp.createAuthorizationRequest")
    async createAuthorizationRequest(
        sessionId: string,
        noRedirect = false,
    ): Promise<string> {
        const session = await this.sessionStore.getForInternalFlow(sessionId);

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "session.requestId": session.requestId ?? "",
        });

        // if noRedirect is true, we want to keep the redirectUri undefined in the session, as it will be used by the client to decide whether to redirect or not after receiving the response. If it's defined, the client will always redirect, even if it was instructed not to.
        if (noRedirect) {
            await this.sessionStore.updateForTenant(
                session.tenantId,
                session.id,
                {
                    redirectUri: null,
                },
            );
        }

        // Create audit logging context
        const logContext: AuditLogContext = {
            sessionId: session.id,
            tenantId: session.tenantId,
            flowType: "OID4VP",
            stage: "authorization_request",
        };

        this.auditLogger.logFlowStart(logContext, {
            requestId: session.requestId,
            action: "create_authorization_request",
        });

        try {
            const host = this.settings.publicUrl;
            const tenantHost = `${host}/issuers/${session.tenantId}`;

            const presentationConfig =
                await this.presentationConfigService.getPresentationConfig(
                    session.requestId!,
                    session.tenantId,
                );
            let regCert: string | undefined = undefined;

            // Becomes the wallet-facing query below, which no longer fits the
            // stored DCQL type.
            let dcql_query: any = resolveDcqlTenantUrl(
                presentationConfig.dcql_query,
                host,
                session.tenantId,
            );

            // Transform internal etsi_tl trusted_authorities (TrustListRef objects)
            // to the DCQL-compliant aki format (base64url key identifiers of the
            // listed issuers). Wallets must receive string values per OID4VP 1.0 §6.
            dcql_query =
                await this.trustedAuthoritiesService.transformDcqlTrustedAuthoritiesToAki(
                    dcql_query,
                    session.tenantId,
                    tenantHost,
                );

            // Some wallets do not yet handle trusted_authorities correctly.
            // VP_REMOVE_TA is an escape hatch to strip it from the DCQL query
            // sent to wallets; disabled by default.
            dcql_query = applyTrustedAuthoritiesPolicy(
                dcql_query,
                this.settings.removeTrustedAuthorities,
            );

            // Sign with the key chain the offer's client_id was derived from:
            // the default access key chain may have changed since then. A
            // rotation of that key chain in between still changes its
            // certificate. Sessions from before the key chain was stored
            // resolve it again.
            const cert = await this.certService.find({
                tenantId: session.tenantId,
                type: KeyUsageType.Access,
                keyId:
                    session.accessKeyChainId ??
                    presentationConfig.accessKeyChainId ??
                    undefined,
            });

            // The registration certificate links the access certificate that
            // signs this request.
            if (presentationConfig.registration_cert) {
                regCert =
                    await this.registrationCertificateService.getOrIssueRegistrationCertificate(
                        presentationConfig,
                        dcql_query,
                        session.requestId!,
                        cert,
                    );
            }
            const nonce = randomUUID();
            await this.sessionStore.updateForTenant(
                session.tenantId,
                session.id,
                {
                    vp_nonce: nonce,
                },
            );

            const lifeTime = 60 * 60;

            const clientId =
                session.clientId ?? createClientId(cert, this.certService);
            const federation = isFederationClientId(clientId);

            const trustChain = federation
                ? await this.federationTrustChain(session.tenantId, clientId)
                : undefined;

            // Use transaction_data from session (which may have been overridden) or fall back to config
            const transaction_data =
                (
                    session.transaction_data ??
                    presentationConfig.transaction_data
                )?.map((td) => base64url.encode(JSON.stringify(td))) ||
                undefined;

            const responseEncryptionPublicJwk =
                await this.responseEncryptionKey(session, federation);

            // Per OID4VP spec Section 13.3: use walletNonce in wallet-facing URLs
            // to separate the wallet-facing identifier (request-id) from the
            // frontend-facing session ID (transaction-id).
            const walletFacingId = session.walletNonce ?? session.id;
            // The origin was chosen when the offer was created; the Origin
            // header of whoever fetches the request never decides it.
            if (session.useDcApi && !session.browserOrigin) {
                throw new BadRequestException(
                    "DC API session has no allowed origin; create a new presentation request",
                );
            }

            const request = {
                payload: {
                    response_type: "vp_token",
                    client_id: clientId,
                    response_uri: `${host}/presentations/${walletFacingId}/oid4vp`,
                    response_mode: session.useDcApi
                        ? "dc_api.jwt"
                        : "direct_post.jwt",
                    nonce,
                    expected_origins: session.useDcApi
                        ? [session.browserOrigin!]
                        : undefined,
                    dcql_query,
                    client_metadata: {
                        jwks: {
                            keys: [responseEncryptionPublicJwk],
                        },
                        vp_formats_supported:
                            this.verifierMetadata.vpFormatsSupported(),
                        encrypted_response_enc_values_supported:
                            ENCRYPTED_RESPONSE_ENC_VALUES_SUPPORTED,
                    },
                    state: presentationRequestState(session),
                    transaction_data,
                    //TODO: check if this value is correct accroding to https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-aud-of-a-request-object
                    aud: clientId.startsWith(`${ClientIdScheme.X509_SAN_DNS}:`)
                        ? host
                        : "https://self-issued.me/v2",
                    exp: Math.floor(Date.now() / 1000) + lifeTime,
                    iat: Math.floor(Date.now() / 1000),
                    verifier_info: regCert
                        ? [
                              {
                                  format: "registration_cert",
                                  data: regCert,
                              },
                          ]
                        : undefined,
                },
                header: {
                    typ: "oauth-authz-req+jwt",
                },
            };

            // signJWT sets the kid of the access key, which the
            // openid_credential_verifier metadata of the entity lists.
            const header: Record<string, unknown> = federation
                ? { ...request.header }
                : {
                      ...request.header,
                      x5c: this.certService.getCertChain(cert),
                  };
            if (trustChain) header.trust_chain = trustChain;

            const signedJwt = await this.keyChainService.signJWT(
                request.payload,
                header,
                session.tenantId,
                cert.keyId,
            );

            return signedJwt;
        } catch (error) {
            this.auditLogger.logFlowError(logContext, error as Error, {
                requestId: session.requestId,
                action: "create_authorization_request",
            });
            throw error;
        }
    }

    /**
     * The trust chain for a request with an `openid_federation` client_id,
     * when configured. It goes into the JWS header (OpenID Federation
     * Section 4.3). OID4VP 1.0 Section 5.9.3 also allows it as a request
     * parameter, but @openid4vc/openid4vp 0.7 wallets reject that parameter
     * with an openid_federation: client_id.
     *
     * @throws BadRequestException when the client_id no longer names the
     * tenant's federation verifier entity
     */
    private async federationTrustChain(
        tenantId: string,
        clientId: string,
    ): Promise<string[] | undefined> {
        const entity = await this.federationIdentity.forTenant(tenantId);
        if (
            !entity ||
            entity.entityIdProblem ||
            clientId !== federationClientId(entity.entityId)
        ) {
            throw new BadRequestException(
                "The OpenID Federation verifier identity of this request is no longer configured",
            );
        }
        return entity.includeTrustChain
            ? this.federationIdentity.trustChain(tenantId)
            : undefined;
    }

    /**
     * The key the wallet encrypts its response to. With openid_federation
     * the wallet ignores client_metadata and encrypts to a key of the
     * verifier metadata in the trust chain: the tenant encryption key, which
     * decrypts the response when the session holds no ephemeral key.
     * Otherwise each session gets an ephemeral key pair.
     */
    private async responseEncryptionKey(
        session: SessionData,
        federation: boolean,
    ): Promise<JWK> {
        if (federation) {
            return this.encryptionService.getEncryptionPublicKey(
                session.tenantId,
            );
        }
        const { publicJwk, privateJwk } =
            await this.encryptionService.generateEphemeralEncryptionKeyPair();
        await this.sessionStore.updateForTenant(session.tenantId, session.id, {
            responseEncryptionPrivateJwk: privateJwk,
        });
        return publicJwk;
    }

    /**
     * Creates a request for the OID4VP flow.
     * @param requestId
     * @param values
     * @param tenantId
     * @returns
     */
    async createRequest(
        requestId: string,
        values: PresentationRequestOptions,
        tenantId: string,
        useDcApi: boolean,
        expectedOrigin?: string,
    ): Promise<OfferResponse> {
        const presentationConfig =
            await this.presentationConfigService.getPresentationConfig(
                requestId,
                tenantId,
            );
        const browserOrigin = useDcApi
            ? allowedExpectedOrigin(
                  requestId,
                  expectedOrigin,
                  presentationConfig.allowedOrigins,
              )
            : undefined;
        const fresh = values.session === undefined;
        values.session = values.session || v4();

        // Per OID4VP spec Section 13.3: generate a separate walletNonce for
        // wallet-facing URLs so the QR code / request_uri does not reveal the
        // session ID (transaction-id) used by the frontend for polling.
        const walletNonce = randomUUID();

        const request_uri_method: "get" | "post" = "get";

        const cert = await this.certService.find({
            tenantId: tenantId,
            type: KeyUsageType.Access,
            keyId: presentationConfig.accessKeyChainId ?? undefined,
        });

        let clientId: string;
        if (values.clientIdScheme === ClientIdScheme.OPENID_FEDERATION) {
            const entity = await this.federationIdentity.forTenant(tenantId);
            if (!entity) {
                throw new BadRequestException(
                    "clientIdScheme openid_federation needs federation.entityId, at least one trust anchor and openid_credential_verifier in federation.entityTypes of the issuance configuration",
                );
            }
            if (entity.entityIdProblem) {
                throw new BadRequestException(
                    `clientIdScheme openid_federation needs a valid federation.entityId in the issuance configuration: ${entity.entityIdProblem}`,
                );
            }
            clientId = federationClientId(entity.entityId);
        } else {
            clientId = createClientId(
                cert,
                this.certService,
                values.clientIdScheme,
            );
        }

        const params = {
            client_id: clientId,
            request_uri: `${this.settings.publicUrl}/presentations/${walletNonce}/oid4vp/request`,
            request_uri_method,
        };
        const queryString = Object.entries(params)
            .map(
                ([key, value]) =>
                    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
            )
            .join("&");

        // Create cross-device params with /no-redirect appended to request_uri
        const crossDeviceParams = {
            ...params,
            request_uri: `${this.settings.publicUrl}/presentations/${walletNonce}/oid4vp/request/no-redirect`,
        };
        const crossDeviceQueryString = Object.entries(crossDeviceParams)
            .map(
                ([key, value]) =>
                    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
            )
            .join("&");

        const expiresAt = new Date(
            Date.now() + (presentationConfig.lifeTime ?? 300) * 1000,
        );

        if (fresh) {
            const host = this.settings.publicUrl;
            const responseUri = useDcApi
                ? undefined
                : `${host}/presentations/${walletNonce}/oid4vp`;

            // Use transaction_data from options if provided, otherwise fall back to config
            const transaction_data =
                values.transaction_data ?? presentationConfig.transaction_data;
            const endpointWebhook = await this.resolveWebhookFromEndpoint(
                presentationConfig.webhookEndpointId,
                tenantId,
            );

            const session = await this.createSession.execute({
                id: values.session,
                walletNonce,
                webhookEndpointId:
                    presentationConfig.webhookEndpointId ?? undefined,
                parsedWebhook: values.webhook ?? endpointWebhook,
                redirectUri:
                    values.redirectUri ??
                    presentationConfig.redirectUri ??
                    undefined,
                tenantId,
                requestId,
                reference: values.reference,
                requestUrl: `openid4vp://?${queryString}`,
                expiresAt,
                useDcApi,
                browserOrigin,
                clientId,
                accessKeyChainId: cert.keyId,
                responseUri,
                transaction_data,
                skewSeconds:
                    values.skewSeconds ??
                    presentationConfig.skewSeconds ??
                    DEFAULT_VERIFIER_SKEW_SECONDS,
            });

            if (request_uri_method === "get") {
                const signedJwt = await this.createAuthorizationRequest(
                    session.id,
                );
                // Store the request object before the offer is returned, so
                // the wallet (or a DC API caller reading the session) gets
                // this exact JWT instead of racing the write.
                await this.sessionStore.updateForTenant(
                    tenantId,
                    values.session,
                    {
                        requestObject: signedJwt,
                    },
                );
            }
        } else {
            await this.sessionStore.updateForTenant(tenantId, values.session, {
                walletNonce,
                requestUrl: `openid4vp://?${queryString}`,
                expiresAt,
                useDcApi,
                browserOrigin,
                clientId,
                accessKeyChainId: cert.keyId,
            });
        }

        return {
            uri: queryString,
            crossDeviceUri: crossDeviceQueryString,
            session: values.session,
        };
    }

    /**
     * Records an OAuth 2.0 error response from the wallet (e.g. the user
     * declined), marks the session as failed and reports the failure to the
     * presentation webhook. Per OID4VP 1.0 §8.2 a successfully processed
     * Authorization Error Response is answered with HTTP 200, optionally
     * carrying a redirect_uri.
     */
    private async handleWalletError(
        session: SessionData,
        walletError: WalletErrorResponse,
    ): Promise<{ redirect_uri?: string }> {
        const errorMessage = walletError.error_description
            ? `${walletError.error}: ${walletError.error_description}`
            : walletError.error;

        const logContext: AuditLogContext = {
            sessionId: session.id,
            tenantId: session.tenantId,
            flowType: "OID4VP",
            stage: "response_processing",
        };

        this.auditLogger.logFlowError(
            logContext,
            new Error(`Wallet error response: ${errorMessage}`),
            {
                action: "wallet_error_response",
                errorCode: walletError.error,
                errorDescription: walletError.error_description,
            },
        );

        // The wallet's OAuth error code (e.g. `access_denied`) is already a
        // stable, spec-defined code, so it becomes the session's failure code.
        // The failure is recorded conditionally, so a late error response
        // cannot overwrite a session that already finished or expired.
        const reason = `Wallet error: ${errorMessage}`;
        const webhook = await this.resolveFailureWebhook(session);
        const failure = await this.failPresentationResponse.execute({
            tenantId: session.tenantId,
            sessionId: session.id,
            requestId: session.requestId,
            message: reason,
            code: walletError.error,
            source: "wallet",
            description: walletError.error_description,
            publish: webhook ? { webhook, session } : undefined,
        });
        if (!failure.failed) {
            throw new BadRequestException(
                "The presentation offer has already been used",
            );
        }
        if (failure.publicationFailed) {
            this.auditLogger.logFlowError(
                logContext,
                failure.publicationError as Error,
                { action: "webhook_callback" },
            );
        }

        // As on success, a redirectUri returned by the webhook replaces the
        // configured one.
        const redirectUri = failure.redirectUri || session.redirectUri;
        if (!redirectUri) {
            return {};
        }

        const processedRedirectUri = decodeURIComponent(redirectUri).replaceAll(
            "{sessionId}",
            session.id,
        );
        const separator = processedRedirectUri.includes("?") ? "&" : "?";
        return {
            redirect_uri: `${processedRedirectUri}${separator}error=${encodeURIComponent(walletError.error)}${walletError.error_description ? `&error_description=${encodeURIComponent(walletError.error_description)}` : ""}`,
        };
    }

    /**
     * Processes the response from the wallet.
     * Per OID4VP spec Section 13.3, the nonce parameter is the walletNonce
     * from the URL path (not the session ID).
     * @param body
     * @param nonce - walletNonce from the URL path (or session ID for legacy sessions)
     */
    @Span("oid4vp.getResponse")
    async getResponse(body: AuthorizationResponse, nonce: string) {
        const session = await this.resolveSessionByNonce(nonce);

        this.logger.debug(
            {
                sessionId: session.id,
                tenantId: session.tenantId,
                hasEncryptedResponse: !!body.response,
                hasWalletError: !!body.error,
                hasState: !!body.state,
                useDcApi: session.useDcApi,
            },
            "Received OID4VP authorization response",
        );

        // Enforce single-use validation: prevent replay attacks
        // Check if this presentation request has already been consumed
        if (session.consumed) {
            throw new BadRequestException(
                "The presentation offer has already been used",
            );
        }
        try {
            assertSessionUsable(session, new Date());
        } catch (error) {
            throw sessionNotUsableException(error);
        }

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "session.requestId": session.requestId ?? "",
        });

        // Handle wallet error responses per OID4VP 1.0 §8.2: when the wallet
        // cannot fulfill the request, it sends an OAuth 2.0 error response.
        if (isWalletErrorResponse(body)) {
            return this.handleWalletError(session, body);
        }

        // Ensure response field is present for success path
        if (!body.response) {
            throw new BadRequestException(
                "Missing response field in authorization response",
            );
        }

        let decrypted: unknown;
        try {
            decrypted =
                await this.encryptionService.decryptJweWithPrivateJwk<unknown>(
                    body.response,
                    session.tenantId,
                    session.responseEncryptionPrivateJwk as
                        | Record<string, unknown>
                        | undefined,
                );
        } catch (error) {
            // A response the wallet encrypted wrongly, or whose time claims
            // are out of range, is the wallet's error, not the server's.
            if (error instanceof EncryptedResponseRejectedError) {
                throw new BadRequestException(
                    `Could not decrypt the authorization response: ${error.message}`,
                );
            }
            throw error;
        }

        this.logger.debug(
            {
                sessionId: session.id,
                responseKeys:
                    decrypted && typeof decrypted === "object"
                        ? Object.keys(decrypted)
                        : [],
            },
            "Decrypted OID4VP authorization response",
        );

        // With direct_post.jwt the wallet may also encrypt its error response.
        if (isWalletErrorResponse(decrypted)) {
            return this.handleWalletError(session, decrypted);
        }

        let res: AuthResponseData;
        try {
            res = this.parseAuthorizationResponse.execute(decrypted);
        } catch (error) {
            if (error instanceof PresentationResponseValidationError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
        if (this.settings.logDecryptedResponse) {
            this.logger.trace(
                { decryptedResponse: decrypted },
                "[TRACE] Decrypted OID4VP authorization response",
            );
        }

        // Create audit logging context
        const logContext: AuditLogContext = {
            sessionId: session.id,
            tenantId: session.tenantId,
            flowType: "OID4VP",
            stage: "response_processing",
        };

        const presentationConfig =
            await this.presentationConfigService.getPresentationConfig(
                session.requestId!,
                session.tenantId,
            );
        const webhook =
            session.parsedWebhook ??
            (await this.resolveWebhookFromEndpoint(
                session.webhookEndpointId ??
                    presentationConfig.webhookEndpointId,
                session.tenantId,
            ));

        this.auditLogger.logFlowStart(logContext, {
            action: "process_presentation_response",
            hasWebhook: !!webhook,
        });

        try {
            //TODO: load required fields from the config
            const credentials = await this.verifyPresentation(
                res,
                presentationConfig,
                session,
            );

            this.logger.debug(
                {
                    sessionId: session.id,
                    credentialCount: credentials?.length ?? 0,
                    hasWebhook: !!webhook,
                },
                "Verified OID4VP presentation response",
            );

            this.auditLogger.logCredentialVerification(
                logContext,
                !!credentials && credentials.length > 0,
                {
                    credentialCount: credentials?.length || 0,
                    nonce: session.vp_nonce,
                },
            );

            const responseCode = randomUUID();
            const processed = await this.processVerifiedPresentation.execute({
                response: res,
                session,
                credentials,
                responseCode,
                webhook,
                rawPresentationPayload: decrypted,
            });
            if (processed.publicationFailed) {
                this.auditLogger.logFlowError(
                    logContext,
                    processed.publicationError as Error,
                    { action: "webhook_callback" },
                );
            }
            session.redirectUri = processed.redirectUri;

            this.auditLogger.logFlowComplete(logContext, {
                credentialCount: credentials?.length || 0,
                webhookSent: !!webhook,
            });

            //check if a redirect URI is defined and return it to the caller. If so, sendResponse is ignored
            if (session.redirectUri) {
                //TODO: not clear with the brackets are encoded
                // Replace {sessionId} placeholder with actual session ID
                const processedRedirectUri = decodeURIComponent(
                    session.redirectUri,
                ).replaceAll("{sessionId}", session.id);
                // Per OID4VP spec Section 13.3: include response_code in redirect_uri
                // so the frontend can use it to confirm the session completed legitimately.
                const separator = processedRedirectUri.includes("?")
                    ? "&"
                    : "?";
                return {
                    redirect_uri: `${processedRedirectUri}${separator}response_code=${responseCode}`,
                };
            }

            if (body.sendResponse) {
                return credentials;
            }

            return {};
        } catch (error: any) {
            // A concurrent response already completed this session: reject the
            // replay without overwriting the completed session as failed.
            if (error instanceof PresentationAlreadyConsumed) {
                throw new BadRequestException(error.message);
            }

            this.logger.warn(
                {
                    sessionId: session.id,
                    errorName: error?.name,
                    errorMessage: error?.message,
                },
                "OID4VP presentation response processing failed",
            );

            // Structured verification failures (SD-JWT VC and mdoc) carry a
            // machine-readable code and a short, safe message; keep the verbose
            // reason to logs/audit only.
            const structured = classifyVerificationFailure(error);
            // DCQL violations with a code (claim value mismatches) never
            // carry the disclosed values, so their message is safe as is.
            const code =
                structured?.code ??
                (error instanceof IncompletePresentationException
                    ? error.code
                    : undefined);

            this.auditLogger.logFlowError(
                logContext,
                structured?.verbose
                    ? new Error(structured.verbose)
                    : (error as Error),
                {
                    action: "process_presentation_response",
                    ...(code ? { errorCode: code } : {}),
                },
            );

            // An invalid presentation is not a successfully processed response,
            // so it is answered with HTTP 400 (unlike a wallet error response).
            // The failure is documented in the session and communicated via
            // redirect_uri (if configured) or session status.
            const errorMessage = structured
                ? structured.message
                : error instanceof IncompletePresentationException
                  ? error.message
                  : `Presentation validation failed: ${error.message}`;

            const failure = await this.failPresentationResponse.execute({
                tenantId: session.tenantId,
                sessionId: session.id,
                requestId: session.requestId,
                message: errorMessage,
                code,
                source: "verifier",
                credentials: structured ? [structured.credential] : undefined,
                publish: webhook ? { webhook, session } : undefined,
            });
            if (failure.publicationFailed) {
                this.auditLogger.logFlowError(
                    logContext,
                    failure.publicationError as Error,
                    { action: "webhook_callback" },
                );
            }

            // If redirect_uri is configured (or returned by the webhook),
            // return it with error parameter, while propagating HTTP 400.
            const redirectUri = failure.redirectUri || session.redirectUri;
            if (redirectUri) {
                const processedRedirectUri = decodeURIComponent(
                    redirectUri,
                ).replaceAll("{sessionId}", session.id);

                // Append error query parameter to redirect URI
                const separator = processedRedirectUri.includes("?")
                    ? "&"
                    : "?";
                throw new BadRequestException({
                    redirect_uri: `${processedRedirectUri}${separator}error=invalid_request&error_description=${encodeURIComponent(errorMessage)}`,
                });
            }

            // Return empty response body (session status indicates failure)
            // and propagate HTTP 400.
            throw new BadRequestException({});
        }
    }

    /**
     * Verifies the credentials of the `vp_token` and maps verification errors
     * to the HTTP exceptions the response handling above reports.
     */
    @Span("presentations.parseResponse")
    private async verifyPresentation(
        res: AuthResponseData,
        presentationConfig: PresentationQuery,
        session: SessionData,
    ): Promise<VerifiedPresentation> {
        // Add session context to logs (Loki) and span attributes (Tempo).
        // assign() requires nestjs-pino request scope; the @Span decorator may
        // run the method in a separate AsyncLocalStorage context, so guard it.
        try {
            this.logger.assign({ sessionId: session.id });
        } catch {
            // Outside HTTP request scope: span attributes still carry it.
        }
        this.traceService.getSpan()?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "session.requestId": session.requestId ?? "",
        });

        try {
            return await this.verifyPresentationResponse.execute(
                res,
                presentationConfig,
                session,
            );
        } catch (error) {
            throw presentationVerificationException(error);
        }
    }
}

/** An expired or finished presentation request is a client error (HTTP 400). */
function sessionNotUsableException(error: unknown): unknown {
    return error instanceof SessionNotUsable
        ? new BadRequestException(error.message)
        : error;
}

/** Maps presentation verification errors to the HTTP exceptions of the OID4VP API. */
function presentationVerificationException(error: unknown): unknown {
    if (error instanceof IncompletePresentationError) {
        return new IncompletePresentationException(
            error.message,
            error.details,
            error.code,
        );
    }
    if (error instanceof UnknownPresentedCredentialError) {
        return new ConflictException(error.message);
    }
    if (error instanceof UnsupportedCredentialVerifierFormat) {
        return new ConflictException(
            `Unsupported credential type: ${error.format}`,
        );
    }
    if (error instanceof CredentialVerificationFailedError) {
        // The cause keeps the structured failure for the session outcome.
        return new BadRequestException(error.message, { cause: error });
    }
    if (
        error instanceof MultiplePresentationsNotAllowedError ||
        error instanceof InvalidTrustedAuthoritiesError ||
        error instanceof UnknownClaimSetReferenceError ||
        error instanceof TransactionDataBindingError
    ) {
        return new BadRequestException(error.message);
    }
    return error;
}

/**
 * Code, short message, verbose reason and per-credential outcome of a
 * credential verification failure (SD-JWT VC or mdoc), also when wrapped in
 * the HTTP exception of presentationVerificationException. Undefined for
 * other errors.
 */
function classifyVerificationFailure(error: unknown) {
    const failed =
        error instanceof CredentialVerificationFailedError
            ? error
            : error instanceof Error &&
                error.cause instanceof CredentialVerificationFailedError
              ? error.cause
              : undefined;
    if (!failed) {
        return undefined;
    }
    const details = verificationFailureDetails(
        failed.failure.type,
        failed.failure.reason,
    );
    const credential: SessionOutcomeCredential = {
        id: failed.credentialId,
        format: failed.credential.format,
        docType: failed.credential.docType,
        verified: false,
        error: details.code,
        message: details.message,
    };
    return { ...details, credential };
}

/** OAuth 2.0 Authorization Error Response sent by the wallet (OID4VP 1.0 §8.5). */
type WalletErrorResponse = Openid4vpAuthorizationErrorResponse;

/**
 * True when the body or the decrypted response is an error response instead
 * of a `vp_token`, as `@openid4vc/openid4vp` defines it.
 */
function isWalletErrorResponse(value: unknown): value is WalletErrorResponse {
    return zOpenid4vpAuthorizationErrorResponse.safeParse(value).success;
}
