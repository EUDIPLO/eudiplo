import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { base64url } from "jose";
import { Span, TraceService } from "nestjs-otel";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { EncryptionService } from "../../crypto/encryption/encryption.service.js";
import { CertService } from "../../crypto/key/cert/cert.service.js";
import { CryptoImplementationService } from "../../crypto/key/crypto-implementation/crypto-implementation.service.js";
import { KeyChainService } from "../../crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../crypto/key/types/key-usage-type.js";
import { CredentialFormat } from "../../issuer/configuration/credentials/entities/credential.entity.js";
import { WebhookEndpointEntity } from "../../issuer/configuration/webhook-endpoint/entities/webhook-endpoint.entity.js";
import { OfferResponse } from "../../issuer/issuance/oid4vci/dto/offer-request.dto.js";
import { RegistrarService } from "../../registrar/registrar.service.js";
import { CreateSession } from "../../session/application/create-session.js";
import { SessionStore } from "../../session/application/session-store.js";
import { SessionStatus } from "../../session/domain/session-state.js";
import { AuditLogContext } from "../../session/logging/session-audit.service.js";
import { SessionLoggerService } from "../../session/logging/session-logger.service.js";
import { DEFAULT_VERIFIER_SKEW_SECONDS } from "../../trust/types.js";
import { PresentationConfigService } from "../presentations/configuration/presentation-config.service.js";
import { RegistrationCertificateService } from "../presentations/configuration/registration-certificate.service.js";
import { SdJwtVerificationError } from "../presentations/credential/sdjwtvcverifier/sdjwtvcverifier.service.js";
import { shortVerificationMessage } from "../presentations/credential/verification-failure.js";
import { AuthResponse } from "../presentations/dto/auth-response.dto.js";
import { IncompletePresentationException } from "../presentations/exceptions/incomplete-presentation.exception.js";
import { PresentationsService } from "../presentations/presentations.service.js";
import { TrustedAuthoritiesService } from "../presentations/trusted-authorities.service.js";
import { PresentationAlreadyConsumed } from "./application/complete-presentation-response.js";
import { FailPresentationResponse } from "./application/fail-presentation-response.js";
import {
    ParseAuthorizationResponse,
    PresentationResponseValidationError,
} from "./application/parse-authorization-response.js";
import { ProcessVerifiedPresentation } from "./application/process-verified-presentation.js";
import { RetrievePresentationRequest } from "./application/retrieve-presentation-request.js";
import { createClientId } from "./client-id.util.js";
import { applyTrustedAuthoritiesPolicy } from "./dcql-trusted-authorities.util.js";
import { AuthorizationResponse } from "./dto/authorization-response.dto.js";
import {
    ClientIdScheme,
    PresentationRequestOptions,
} from "./dto/presentation-request.dto.js";
import { OID4VP_SETTINGS, type Oid4vpSettings } from "./oid4vp-settings.js";

@Injectable()
export class Oid4vpService {
    constructor(
        @InjectPinoLogger(Oid4vpService.name)
        private readonly logger: PinoLogger,
        private readonly certService: CertService,
        public readonly keyChainService: KeyChainService,
        private readonly encryptionService: EncryptionService,
        private readonly registrarService: RegistrarService,
        private readonly presentationsService: PresentationsService,
        private readonly presentationConfigService: PresentationConfigService,
        private readonly registrationCertificateService: RegistrationCertificateService,
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
        private readonly cryptoImplementationService: CryptoImplementationService,
        private readonly traceService: TraceService,
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
     * Resolves a session from a wallet-facing nonce.
     * Per OID4VP spec Section 13.3, wallet-facing URLs use a separate walletNonce
     * instead of the session ID. Falls back to session ID lookup for backward
     * compatibility with sessions created before the walletNonce migration.
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
        origin: string,
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

        return this.retrievePresentationRequest.execute(
            session,
            origin,
            noRedirect,
            (sessionId, requestOrigin, shouldNotRedirect) =>
                this.createAuthorizationRequest(
                    sessionId,
                    requestOrigin,
                    shouldNotRedirect,
                ),
        );
    }

    /**
     * Creates an authorization request for a session.
     * @returns
     */
    @Span("oid4vp.createAuthorizationRequest")
    async createAuthorizationRequest(
        sessionId: string,
        origin: string,
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

            let dcql_query = JSON.parse(
                JSON.stringify(presentationConfig.dcql_query).replaceAll(
                    "<TENANT_URL>",
                    tenantHost,
                ),
            );

            // Transform internal etsi_tl trusted_authorities (TrustListRef objects)
            // to the DCQL-compliant aki format (base64url Subject Key Identifier
            // strings). Wallets must receive string values per OID4VP 1.0 Final §6.
            dcql_query =
                await this.trustedAuthoritiesService.transformDcqlTrustedAuthoritiesToAki(
                    dcql_query,
                    session.tenantId,
                );

            // Some wallets do not yet handle trusted_authorities correctly.
            // VP_REMOVE_TA is an escape hatch to strip it from the DCQL query
            // sent to wallets; disabled by default.
            dcql_query = applyTrustedAuthoritiesPolicy(
                dcql_query,
                this.settings.removeTrustedAuthorities,
            );

            if (
                presentationConfig.registration_cert &&
                (await this.registrarService.isEnabledForTenant(
                    session.tenantId,
                ))
            ) {
                regCert =
                    await this.registrationCertificateService.getOrIssueRegistrationCertificate(
                        presentationConfig,
                        dcql_query,
                        session.requestId!,
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

            const cert = await this.certService.find({
                tenantId: session.tenantId,
                type: KeyUsageType.Access,
                keyId: presentationConfig.accessKeyChainId ?? undefined,
            });

            const clientId =
                session.clientId ?? createClientId(cert, this.certService);

            // Use transaction_data from session (which may have been overridden) or fall back to config
            const transaction_data =
                (
                    session.transaction_data ??
                    presentationConfig.transaction_data
                )?.map((td) => base64url.encode(JSON.stringify(td))) ||
                undefined;

            const { publicJwk: responseEncryptionPublicJwk, privateJwk } =
                await this.encryptionService.generateEphemeralEncryptionKeyPair();
            await this.sessionStore.updateForTenant(
                session.tenantId,
                session.id,
                {
                    responseEncryptionPrivateJwk: privateJwk,
                },
            );

            // Per OID4VP spec Section 13.3: use walletNonce in wallet-facing URLs
            // to separate the wallet-facing identifier (request-id) from the
            // frontend-facing session ID (transaction-id).
            const walletFacingId = session.walletNonce ?? session.id;
            const normalizedExpectedOrigin = session.useDcApi
                ? this.normalizeExpectedOrigin(origin)
                : undefined;

            if (session.useDcApi && !normalizedExpectedOrigin) {
                this.logger.warn(
                    { sessionId: session.id, origin },
                    "Missing or invalid Origin header for DC API request; expected_origins omitted",
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
                    expected_origins: normalizedExpectedOrigin
                        ? [normalizedExpectedOrigin]
                        : undefined,
                    dcql_query,
                    client_metadata: {
                        jwks: {
                            keys: [responseEncryptionPublicJwk],
                        },
                        vp_formats_supported: {
                            mso_mdoc: {
                                alg: this.cryptoImplementationService.getAlgs(
                                    CredentialFormat.MSO_MDOC,
                                ),
                            },
                            "dc+sd-jwt": {
                                "kb-jwt_alg_values":
                                    this.cryptoImplementationService.getAlgs(
                                        CredentialFormat.SD_JWT_VC,
                                    ),
                                "sd-jwt_alg_values":
                                    this.cryptoImplementationService.getAlgs(
                                        CredentialFormat.SD_JWT_VC,
                                    ),
                            },
                        },
                        encrypted_response_enc_values_supported: [
                            "A128GCM",
                            "A256GCM",
                        ],
                    },
                    state: session.useDcApi ? undefined : walletFacingId,
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

            const header = {
                ...request.header,
                alg: "ES256",
                x5c: this.certService.getCertChain(cert),
            };

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

    private normalizeExpectedOrigin(origin: string): string | undefined {
        const trimmed = origin.trim();
        if (!trimmed) {
            return undefined;
        }

        const prefixed = /^https?:\/\//i.test(trimmed)
            ? trimmed
            : `http://${trimmed}`;

        try {
            return new URL(prefixed).origin;
        } catch {
            return undefined;
        }
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
        origin: string,
    ): Promise<OfferResponse> {
        const presentationConfig =
            await this.presentationConfigService.getPresentationConfig(
                requestId,
                tenantId,
            );
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

        const clientId = createClientId(
            cert,
            this.certService,
            values.clientIdScheme,
        );

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
                requestUrl: `openid4vp://?${queryString}`,
                expiresAt,
                useDcApi,
                clientId,
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
                    origin,
                );
                this.sessionStore.updateForTenant(tenantId, values.session, {
                    requestObject: signedJwt,
                });
            }
        } else {
            await this.sessionStore.updateForTenant(tenantId, values.session, {
                walletNonce,
                requestUrl: `openid4vp://?${queryString}`,
                expiresAt,
                useDcApi,
                clientId,
            });
        }

        return {
            uri: queryString,
            crossDeviceUri: crossDeviceQueryString,
            session: values.session,
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

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "session.requestId": session.requestId ?? "",
        });

        // The expected state value is the walletNonce (or session.id for legacy sessions)

        // Handle wallet error responses per OID4VP spec section 6.2
        // When wallet cannot fulfill the request, it sends an OAuth 2.0 error response
        if (body.error) {
            const errorMessage = body.error_description
                ? `${body.error}: ${body.error_description}`
                : body.error;

            // Create audit logging context for error response
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
                    errorCode: body.error,
                    errorDescription: body.error_description,
                },
            );

            // Update session with failed status
            await this.sessionStore.updateForTenant(
                session.tenantId,
                session.id,
                {
                    status: SessionStatus.Failed,
                    errorReason: `Wallet error: ${errorMessage}`,
                    responseEncryptionPrivateJwk: null,
                },
            );

            // Return redirect_uri with error if configured
            // and propagate HTTP 400 while preserving response body shape.
            if (session.redirectUri) {
                const processedRedirectUri = decodeURIComponent(
                    session.redirectUri,
                ).replaceAll("{sessionId}", session.id);

                const separator = processedRedirectUri.includes("?")
                    ? "&"
                    : "?";
                throw new BadRequestException({
                    redirect_uri: `${processedRedirectUri}${separator}error=${encodeURIComponent(body.error)}${body.error_description ? `&error_description=${encodeURIComponent(body.error_description)}` : ""}`,
                });
            }

            // Return empty response body (session status indicates failure)
            // and propagate HTTP 400.
            throw new BadRequestException({});
        }

        // Ensure response field is present for success path
        if (!body.response) {
            throw new BadRequestException(
                "Missing response field in authorization response",
            );
        }

        const decrypted =
            await this.encryptionService.decryptJweWithPrivateJwk<AuthResponse>(
                body.response,
                session.tenantId,
                session.responseEncryptionPrivateJwk as
                    | Record<string, unknown>
                    | undefined,
            );

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

        let res: AuthResponse;
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

        //for dc api the state is no longer included in the res, see: https://openid.net/specs/openid-4-verifiable-presentations-1_0.html#name-request

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
            const credentials = await this.presentationsService.parseResponse(
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

            // Structured verification failures carry a machine-readable code and
            // a short, safe message; keep the verbose reason to logs/audit only.
            const structured =
                error instanceof SdJwtVerificationError
                    ? {
                          code: error.failureType,
                          message: shortVerificationMessage(error.failureType),
                          verbose: error.verboseReason,
                      }
                    : undefined;

            this.auditLogger.logFlowError(
                logContext,
                structured?.verbose
                    ? new Error(structured.verbose)
                    : (error as Error),
                {
                    action: "process_presentation_response",
                    ...(structured?.code ? { errorCode: structured.code } : {}),
                },
            );

            // Per OID4VP spec, the verifier MUST always return HTTP 200.
            // Validation failures are documented in the session and communicated
            // via redirect_uri (if configured) or session status.
            const errorMessage = structured
                ? structured.message
                : error instanceof IncompletePresentationException
                  ? error.message
                  : `Presentation validation failed: ${error.message}`;

            await this.failPresentationResponse.execute({
                tenantId: session.tenantId,
                sessionId: session.id,
                message: errorMessage,
                code: structured?.code,
            });

            // If redirect_uri is configured, return it with error parameter,
            // while propagating HTTP 400.
            if (session.redirectUri) {
                const processedRedirectUri = decodeURIComponent(
                    session.redirectUri,
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
}
