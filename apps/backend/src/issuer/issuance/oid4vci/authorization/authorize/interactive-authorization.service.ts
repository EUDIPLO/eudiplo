import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
    type AuthorizationServerMetadata,
    Jwk,
    Oauth2ErrorCodes,
} from "@openid4vc/oauth2";
import { Repository } from "typeorm";
import { v4 } from "uuid";
import { CryptoService } from "../../../../../crypto/crypto.service.js";
import { CreateSession } from "../../../../../session/application/create-session.js";
import { SessionStore } from "../../../../../session/application/session-store.js";
import { Oid4vpService } from "../../../../../verifier/oid4vp/oid4vp.service.js";
import { PresentationsService } from "../../../../../verifier/presentations/presentations.service.js";
import { CredentialsService } from "../../../../configuration/credentials/credentials.service.js";
import {
    type IaeAction,
    type IaeActionOpenid4vpPresentation,
    IaeActionType,
} from "../../../../configuration/credentials/entities/iae-action.dto.js";
import { IssuanceService } from "../../../../configuration/issuance/issuance.service.js";
import {
    InteractiveAuthSessionEntity,
    InteractiveAuthSessionStatus,
} from "../../entities/interactive-auth-session.entity.js";
import type { Oid4vciRequestContext } from "../../request-context.js";
import {
    InteractionType,
    InteractiveAuthorizationRequestDto,
    InteractiveAuthorizationRequestType,
    type InteractiveAuthorizationResponse,
    type Openid4vpRequestDto,
} from "./dto/interactive-authorization.dto.js";

/**
 * Initial interactive authorization request from wallet.
 */
interface InteractiveAuthInitialRequest {
    response_type: string;
    client_id: string;
    interaction_types_supported: string;
    redirect_uri?: string;
    scope?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    authorization_details?: any[];
    state?: string;
    issuer_state?: string;
}

/**
 * Follow-up interactive authorization request from wallet.
 */
interface InteractiveAuthFollowUpRequest {
    auth_session: string;
    openid4vp_response?: string;
    code_verifier?: string;
}

/**
 * Parsed result from interactive authorization request.
 */
interface ParsedInteractiveAuthorizationRequest {
    type: InteractiveAuthorizationRequestType;
    request: InteractiveAuthInitialRequest | InteractiveAuthFollowUpRequest;
    dpop?: {
        jwk: Jwk;
        jwt: string;
    };
    clientAttestation?: {
        clientAttestationJwt: string;
        clientAttestationPopJwt: string;
    };
}

/**
 * Service for handling Interactive Authorization Endpoint (IAE) operations.
 *
 * The IAE enables a presentation flow during credential issuance, allowing
 * the issuer to request verifiable presentations from the wallet before
 * issuing credentials.
 *
 * Supports two interaction types:
 * - openid4vp_presentation: Requests a verifiable presentation via OpenID4VP
 * - redirect_to_web: Redirects to a web-based authorization flow
 */
@Injectable()
export class InteractiveAuthorizationService {
    private readonly logger = new Logger(InteractiveAuthorizationService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly cryptoService: CryptoService,
        private readonly createSession: CreateSession,
        private readonly sessionStore: SessionStore,
        private readonly issuanceService: IssuanceService,
        private readonly credentialsService: CredentialsService,
        private readonly oid4vpService: Oid4vpService,
        private readonly presentationsService: PresentationsService,
        @InjectRepository(InteractiveAuthSessionEntity)
        private readonly authSessionRepository: Repository<InteractiveAuthSessionEntity>,
    ) {}

    /**
     * Get the authorization server metadata for interactive authorization.
     * @param tenantId The tenant ID
     * @returns The authorization server metadata
     */
    getAuthorizationServerMetadata(
        tenantId: string,
    ): AuthorizationServerMetadata {
        const authServer = `${this.configService.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenantId}`;
        return {
            issuer: authServer,
            authorization_endpoint: `${authServer}/authorize`,
            token_endpoint: `${authServer}/authorize/token`,
            interactive_authorization_endpoint: `${authServer}/authorize/interactive`,
        };
    }

    /**
     * Parse an interactive authorization request.
     * Determines if the request is an initial or follow-up request.
     *
     * @param body The request body
     * @param req The Express request
     * @param tenantId The tenant ID
     * @returns Parsed request with type indication
     */
    parseRequest(
        body: InteractiveAuthorizationRequestDto,
        req: Oid4vciRequestContext,
        tenantId: string,
    ): ParsedInteractiveAuthorizationRequest {
        // Check for client attestation headers
        const clientAttestationJwt = req.headers["oauth-client-attestation"] as
            | string
            | undefined;
        const clientAttestationPopJwt = req.headers[
            "oauth-client-attestation-pop"
        ] as string | undefined;
        const clientAttestation =
            clientAttestationJwt && clientAttestationPopJwt
                ? { clientAttestationJwt, clientAttestationPopJwt }
                : undefined;

        // Check for DPoP header
        const dpopHeader = req.headers["dpop"] as string | undefined;
        // DPoP parsing would require JWT decoding - simplified for now
        const dpop = dpopHeader
            ? { jwt: dpopHeader, jwk: {} as Jwk }
            : undefined;

        // Determine request type based on presence of auth_session vs interaction_types_supported
        if (body.auth_session) {
            // This is a follow-up request
            return {
                type: InteractiveAuthorizationRequestType.FOLLOW_UP,
                request: {
                    auth_session: body.auth_session,
                    openid4vp_response: body.openid4vp_response,
                    code_verifier: body.code_verifier,
                },
            };
        }

        if (!body.interaction_types_supported) {
            throw new BadRequestException(
                "Missing required parameter: interaction_types_supported",
            );
        }

        // This is an initial request
        return {
            type: InteractiveAuthorizationRequestType.INITIAL,
            request: {
                response_type: body.response_type || "code",
                client_id: body.client_id || "",
                interaction_types_supported: body.interaction_types_supported,
                redirect_uri: body.redirect_uri,
                scope: body.scope,
                code_challenge: body.code_challenge,
                code_challenge_method: body.code_challenge_method,
                authorization_details: this.parseAuthorizationDetails(
                    body.authorization_details,
                ),
                state: body.state,
                issuer_state: body.issuer_state,
            },
            dpop,
            clientAttestation,
        };
    }

    /**
     * Parse authorization_details which can be a string or array.
     */
    private parseAuthorizationDetails(authDetails: any): any[] | undefined {
        if (!authDetails) return undefined;
        if (typeof authDetails === "string") {
            try {
                return JSON.parse(authDetails);
            } catch {
                return undefined;
            }
        }
        return authDetails;
    }

    /**
     * Handle an interactive authorization request.
     * Routes to the appropriate handler based on request type.
     *
     * @param body The request body
     * @param req The Express request
     * @param tenantId The tenant ID
     * @param origin The request origin
     * @returns The interactive authorization response
     */
    async handleRequest(
        body: InteractiveAuthorizationRequestDto,
        req: Oid4vciRequestContext,
        tenantId: string,
        origin: string,
    ): Promise<InteractiveAuthorizationResponse> {
        try {
            const parsed = this.parseRequest(body, req, tenantId);

            if (parsed.type === InteractiveAuthorizationRequestType.INITIAL) {
                return await this.handleInitialRequest(
                    parsed.request as InteractiveAuthInitialRequest,
                    tenantId,
                    origin,
                    parsed.dpop,
                    parsed.clientAttestation,
                );
            } else {
                return await this.handleFollowUpRequest(
                    parsed.request as InteractiveAuthFollowUpRequest,
                    tenantId,
                    origin,
                );
            }
        } catch (error) {
            this.logger.error(
                "Error handling interactive authorization request:",
                error,
            );
            if (error instanceof BadRequestException) {
                return {
                    error: Oauth2ErrorCodes.InvalidRequest,
                    error_description: error.message,
                };
            }
            return {
                error: Oauth2ErrorCodes.ServerError,
                error_description:
                    error instanceof Error ? error.message : "Unknown error",
            };
        }
    }

    /**
     * Handle an initial interactive authorization request.
     * Creates an auth session and returns the appropriate interaction response.
     *
     * If the credential config has iaeActions defined, those are used.
     * Otherwise, falls back to the default behavior based on wallet-supported types.
     */
    private async handleInitialRequest(
        request: InteractiveAuthInitialRequest,
        tenantId: string,
        origin: string,
        dpop?: { jwk: Jwk; jwt: string },
        clientAttestation?: {
            clientAttestationJwt: string;
            clientAttestationPopJwt: string;
        },
    ): Promise<InteractiveAuthorizationResponse> {
        // Validate required fields
        if (!request.client_id) {
            return {
                error: Oauth2ErrorCodes.InvalidRequest,
                error_description: "Missing required parameter: client_id",
            };
        }

        // Parse supported interaction types
        const supportedTypes = request.interaction_types_supported
            .split(",")
            .map((t) => t.trim()) as InteractionType[];

        // Load IAE actions from credential config if available
        let iaeActions: IaeAction[] | undefined;
        if (request.authorization_details?.length) {
            const credentialConfigId =
                request.authorization_details[0]?.credential_configuration_id;
            if (credentialConfigId) {
                const credentialConfig =
                    await this.credentialsService.getCredentialConfig(
                        credentialConfigId,
                        tenantId,
                    );
                if (credentialConfig?.iaeActions?.length) {
                    iaeActions = credentialConfig.iaeActions;
                    this.logger.debug(
                        `Loaded ${iaeActions.length} IAE actions for credential ${credentialConfigId}`,
                    );
                }
            }
        }

        // Create auth session
        const authSession = v4();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Store the auth session
        await this.authSessionRepository.save({
            authSession,
            tenantId,
            clientId: request.client_id,
            redirectUri: request.redirect_uri,
            scope: request.scope,
            codeChallenge: request.code_challenge,
            codeChallengeMethod: request.code_challenge_method,
            issuerState: request.issuer_state,
            state: request.state,
            authorizationDetails: request.authorization_details
                ? JSON.stringify(request.authorization_details)
                : undefined,
            interactionTypesSupported: request.interaction_types_supported,
            dpopJwk: dpop?.jwk ? JSON.stringify(dpop.jwk) : undefined,
            iaeActions: iaeActions ? JSON.stringify(iaeActions) : undefined,
            currentStepIndex: 0,
            completedStepsData: JSON.stringify([]),
            expiresAt,
            status: InteractiveAuthSessionStatus.Pending,
        });

        // If IAE actions are defined, execute the first one
        if (iaeActions?.length) {
            return this.executeIaeAction(
                authSession,
                tenantId,
                origin,
                iaeActions[0],
                supportedTypes,
            );
        }

        // Fallback: Check if we should use OpenID4VP presentation (legacy behavior)
        if (supportedTypes.includes(InteractionType.OPENID4VP_PRESENTATION)) {
            return await this.createOpenid4vpInteractionResponse(
                authSession,
                tenantId,
                origin,
                request.authorization_details,
            );
        }

        // Check if we should use redirect_to_web
        if (supportedTypes.includes(InteractionType.REDIRECT_TO_WEB)) {
            return this.createRedirectToWebResponse(authSession, tenantId);
        }

        // No supported interaction type found
        return {
            error: Oauth2ErrorCodes.InvalidRequest,
            error_description: "No supported interaction type available",
        };
    }

    /**
     * Execute a specific IAE action.
     */
    private async executeIaeAction(
        authSession: string,
        tenantId: string,
        origin: string,
        action: IaeAction,
        supportedTypes: InteractionType[],
    ): Promise<InteractiveAuthorizationResponse> {
        switch (action.type) {
            case IaeActionType.OPENID4VP_PRESENTATION: {
                if (
                    !supportedTypes.includes(
                        InteractionType.OPENID4VP_PRESENTATION,
                    )
                ) {
                    return {
                        error: Oauth2ErrorCodes.InvalidRequest,
                        error_description:
                            "Wallet does not support openid4vp_presentation interaction type",
                    };
                }
                return this.createOpenid4vpInteractionResponseForConfig(
                    authSession,
                    tenantId,
                    origin,
                    action.presentationConfigId,
                    action.label,
                );
            }
            case IaeActionType.REDIRECT_TO_WEB: {
                if (!supportedTypes.includes(InteractionType.REDIRECT_TO_WEB)) {
                    return {
                        error: Oauth2ErrorCodes.InvalidRequest,
                        error_description:
                            "Wallet does not support redirect_to_web interaction type",
                    };
                }
                return this.createRedirectToWebResponseForUrl(
                    authSession,
                    tenantId,
                    action.url,
                    action.description,
                );
            }
            default:
                return {
                    error: Oauth2ErrorCodes.InvalidRequest,
                    error_description: `Unknown IAE action type: ${(action as any).type}`,
                };
        }
    }

    /**
     * Handle a follow-up interactive authorization request.
     * Validates the submitted interaction response and either:
     * - Advances to the next IAE action, or
     * - Issues an authorization code if all steps are complete.
     */
    private async handleFollowUpRequest(
        request: InteractiveAuthFollowUpRequest,
        tenantId: string,
        origin: string,
    ): Promise<InteractiveAuthorizationResponse> {
        // Retrieve and validate the auth session
        const validationResult = await this.validateAuthSession(
            request.auth_session,
            tenantId,
        );
        // Check if it's an error response (has 'error' property) vs entity (has 'id' property)
        if ("error" in validationResult) {
            return validationResult;
        }
        const authSessionEntity =
            validationResult as InteractiveAuthSessionEntity;

        // Parse session context
        const sessionContext = this.parseSessionContext(authSessionEntity);

        // Handle OpenID4VP response
        if (request.openid4vp_response) {
            return this.processOpenid4vpFollow(
                request.openid4vp_response,
                authSessionEntity,
                sessionContext,
                tenantId,
                origin,
            );
        }

        // Handle code_verifier for redirect_to_web flow
        if (request.code_verifier) {
            return this.processCodeVerifierFollow(
                request.code_verifier,
                authSessionEntity,
                sessionContext,
                tenantId,
                origin,
            );
        }

        return {
            error: Oauth2ErrorCodes.InvalidRequest,
            error_description: "Missing openid4vp_response or code_verifier",
        };
    }

    /**
     * Validate and retrieve an auth session.
     */
    private async validateAuthSession(
        authSession: string,
        tenantId: string,
    ): Promise<
        InteractiveAuthSessionEntity | InteractiveAuthorizationResponse
    > {
        const authSessionEntity = await this.authSessionRepository.findOne({
            where: { authSession, tenantId },
        });

        if (!authSessionEntity) {
            return {
                error: Oauth2ErrorCodes.InvalidRequest,
                error_description: "Invalid or expired auth_session",
            };
        }

        if (authSessionEntity.expiresAt < new Date()) {
            await this.authSessionRepository.remove(authSessionEntity);
            return {
                error: Oauth2ErrorCodes.InvalidRequest,
                error_description: "Auth session has expired",
            };
        }

        return authSessionEntity;
    }

    /**
     * Parse session context data.
     */
    private parseSessionContext(authSession: InteractiveAuthSessionEntity): {
        iaeActions: IaeAction[] | undefined;
        completedStepsData: any[];
        supportedTypes: InteractionType[];
    } {
        return {
            iaeActions: authSession.iaeActions
                ? JSON.parse(authSession.iaeActions)
                : undefined,
            completedStepsData: authSession.completedStepsData
                ? JSON.parse(authSession.completedStepsData)
                : [],
            supportedTypes: authSession.interactionTypesSupported
                .split(",")
                .map((t) => t.trim()) as InteractionType[],
        };
    }

    /**
     * Process OpenID4VP follow-up response.
     */
    private async processOpenid4vpFollow(
        openid4vpResponse: string,
        authSession: InteractiveAuthSessionEntity,
        context: ReturnType<typeof this.parseSessionContext>,
        tenantId: string,
        origin: string,
    ): Promise<InteractiveAuthorizationResponse> {
        const result = await this.handleOpenid4vpResponse(
            openid4vpResponse,
            authSession,
        );
        if (!("success" in result)) return result;

        context.completedStepsData.push({
            stepIndex: authSession.currentStepIndex,
            type: IaeActionType.OPENID4VP_PRESENTATION,
            data: openid4vpResponse,
            completedAt: new Date().toISOString(),
        });

        return this.advanceOrComplete(authSession, context, tenantId, origin);
    }

    /**
     * Process code_verifier follow-up response.
     */
    private async processCodeVerifierFollow(
        codeVerifier: string,
        authSession: InteractiveAuthSessionEntity,
        context: ReturnType<typeof this.parseSessionContext>,
        tenantId: string,
        origin: string,
    ): Promise<InteractiveAuthorizationResponse> {
        const result = await this.handleCodeVerifier(codeVerifier, authSession);
        if (!("success" in result)) return result;

        context.completedStepsData.push({
            stepIndex: authSession.currentStepIndex,
            type: IaeActionType.REDIRECT_TO_WEB,
            completedAt: new Date().toISOString(),
        });

        return this.advanceOrComplete(authSession, context, tenantId, origin);
    }

    /**
     * Advance to next IAE action or complete the flow.
     */
    private async advanceOrComplete(
        authSession: InteractiveAuthSessionEntity,
        context: ReturnType<typeof this.parseSessionContext>,
        tenantId: string,
        origin: string,
    ): Promise<InteractiveAuthorizationResponse> {
        const { iaeActions, completedStepsData, supportedTypes } = context;

        // Check if there are more actions
        if (
            iaeActions &&
            authSession.currentStepIndex < iaeActions.length - 1
        ) {
            const nextStepIndex = authSession.currentStepIndex + 1;
            await this.authSessionRepository.update(authSession.id, {
                currentStepIndex: nextStepIndex,
                completedStepsData: JSON.stringify(completedStepsData),
                status: InteractiveAuthSessionStatus.Pending,
            });

            return this.executeIaeAction(
                authSession.authSession,
                tenantId,
                origin,
                iaeActions[nextStepIndex],
                supportedTypes,
            );
        }

        // All steps complete
        await this.authSessionRepository.update(authSession.id, {
            completedStepsData: JSON.stringify(completedStepsData),
            status: InteractiveAuthSessionStatus.AllStepsCompleted,
        });

        return this.issueAuthorizationCode(authSession);
    }

    /**
     * Handle OpenID4VP response from wallet.
     * Validates and stores the VP data, returns success or error.
     */
    private async handleOpenid4vpResponse(
        openid4vpResponse: string,
        authSession: InteractiveAuthSessionEntity,
    ): Promise<{ success: true } | InteractiveAuthorizationResponse> {
        try {
            const vpResponse = JSON.parse(openid4vpResponse);

            // Update session status
            await this.authSessionRepository.update(authSession.id, {
                status: "presentation_received",
                presentationData: openid4vpResponse,
            });

            // If there's an issuer_state, also update the main session
            if (authSession.issuerState) {
                try {
                    await this.sessionStore.updateForTenant(
                        authSession.tenantId,
                        authSession.issuerState,
                        {
                            credentials: vpResponse,
                        },
                    );
                } catch (error) {
                    this.logger.warn(
                        "Could not update main session with presentation data:",
                        error,
                    );
                }
            }

            // Return success indicator (auth code will be issued by advanceOrComplete)
            return { success: true };
        } catch (error) {
            this.logger.error("Failed to process OpenID4VP response:", error);
            return {
                error: Oauth2ErrorCodes.InvalidRequest,
                error_description: "Invalid openid4vp_response format",
            };
        }
    }

    /**
     * Handle PKCE code_verifier for redirect_to_web flow.
     * Validates the code_verifier and returns success or error.
     */
    private async handleCodeVerifier(
        codeVerifier: string,
        authSession: InteractiveAuthSessionEntity,
    ): Promise<{ success: true } | InteractiveAuthorizationResponse> {
        // Verify PKCE
        if (!authSession.codeChallenge) {
            return {
                error: Oauth2ErrorCodes.InvalidRequest,
                error_description:
                    "No code_challenge was provided in initial request",
            };
        }

        const verifierValid = await this.verifyPkce(
            codeVerifier,
            authSession.codeChallenge,
            authSession.codeChallengeMethod,
        );

        if (!verifierValid) {
            return {
                error: Oauth2ErrorCodes.InvalidGrant,
                error_description: "Invalid code_verifier",
            };
        }

        // Check if web authorization was completed
        if (authSession.status !== "web_auth_completed") {
            return {
                error: Oauth2ErrorCodes.AccessDenied,
                error_description: "Web authorization not completed",
            };
        }

        // Return success indicator (auth code will be issued by advanceOrComplete)
        return { success: true };
    }

    /**
     * Create an OpenID4VP interaction response.
     * Generates a presentation request for the wallet.
     *
     * The presentation configuration is determined by:
     * 1. Looking up the credential_configuration_id from authorization_details
     * 2. Using the first iaeAction of type openid4vp_presentation from that credential config
     * 3. Falling back to the first available presentation configuration
     */
    private async createOpenid4vpInteractionResponse(
        authSession: string,
        tenantId: string,
        origin: string,
        authorizationDetails?: any[],
    ): Promise<InteractiveAuthorizationResponse> {
        try {
            // Determine which presentation configuration to use
            let configId: string | undefined;

            // Try to get required presentation from credential configuration's IAE actions
            if (authorizationDetails?.length) {
                const credentialConfigId =
                    authorizationDetails[0]?.credential_configuration_id;
                if (credentialConfigId) {
                    const credentialConfig =
                        await this.credentialsService.getCredentialConfig(
                            credentialConfigId,
                            tenantId,
                        );
                    // Look for first openid4vp_presentation action in iaeActions
                    const presentationAction =
                        credentialConfig?.iaeActions?.find(
                            (a): a is IaeActionOpenid4vpPresentation =>
                                a.type === IaeActionType.OPENID4VP_PRESENTATION,
                        );
                    if (presentationAction) {
                        configId = presentationAction.presentationConfigId;
                        this.logger.debug(
                            `Using presentation config ${configId} from IAE actions for credential ${credentialConfigId}`,
                        );
                    }
                }
            }

            // Fall back to first available presentation configuration
            if (!configId) {
                const configs =
                    await this.presentationsService.getPresentationConfigs(
                        tenantId,
                    );
                configId = configs[0]?.id;
            }

            if (!configId) {
                return {
                    error: Oauth2ErrorCodes.ServerError,
                    error_description:
                        "No presentation configuration available",
                };
            }

            return this.createOpenid4vpInteractionResponseForConfig(
                authSession,
                tenantId,
                origin,
                configId,
            );
        } catch (error) {
            this.logger.error("Failed to create OpenID4VP interaction:", error);
            return {
                error: Oauth2ErrorCodes.ServerError,
                error_description: `Failed to create presentation request: ${error instanceof Error ? error.message : "Unknown error"}`,
            };
        }
    }

    /**
     * Create an OpenID4VP interaction response for a specific presentation config.
     */
    private async createOpenid4vpInteractionResponseForConfig(
        authSession: string,
        tenantId: string,
        origin: string,
        presentationConfigId: string,
        label?: string,
    ): Promise<InteractiveAuthorizationResponse> {
        try {
            // Create the presentation request
            const presentationResult = await this.oid4vpService.createRequest(
                presentationConfigId,
                { session: authSession },
                tenantId,
                false, // useDcApi
                origin,
            );

            // Store the session for later use
            await this.createSession.execute({
                id: authSession,
                tenantId,
                requestId: presentationConfigId,
            });

            // Create the OpenID4VP request object
            const openid4vpRequest: Openid4vpRequestDto = {
                request: presentationResult.uri,
            };

            return {
                status: "require_interaction",
                type: "openid4vp_presentation",
                auth_session: authSession,
                openid4vp_request: openid4vpRequest,
            };
        } catch (error) {
            this.logger.error("Failed to create OpenID4VP interaction:", error);
            return {
                error: Oauth2ErrorCodes.ServerError,
                error_description: `Failed to create presentation request: ${error instanceof Error ? error.message : "Unknown error"}`,
            };
        }
    }

    /**
     * Create a redirect_to_web interaction response.
     * Generates a PAR request URI for web-based authorization.
     */
    private createRedirectToWebResponse(
        authSession: string,
        tenantId: string,
    ): InteractiveAuthorizationResponse {
        return this.createRedirectToWebResponseForUrl(authSession, tenantId);
    }

    /**
     * Create a redirect_to_web interaction response for a specific URL.
     */
    private createRedirectToWebResponseForUrl(
        authSession: string,
        tenantId: string,
        url?: string,
        description?: string,
    ): InteractiveAuthorizationResponse {
        // Create a request_uri for PAR-based web authorization
        const requestUri = `urn:ietf:params:oauth:request_uri:${randomUUID()}`;
        const expiresIn = 600; // 10 minutes

        // Store PAR data in the auth session (async)
        this.authSessionRepository.update(
            { authSession, tenantId },
            {
                requestUri,
                parExpiresAt: new Date(Date.now() + expiresIn * 1000),
            },
        );

        return {
            status: "require_interaction",
            type: "redirect_to_web",
            auth_session: authSession,
            request_uri: requestUri,
            expires_in: expiresIn,
        };
    }

    /**
     * Issue an authorization code after successful interaction.
     */
    private async issueAuthorizationCode(
        authSession: InteractiveAuthSessionEntity,
    ): Promise<InteractiveAuthorizationResponse> {
        const authorizationCode = randomUUID();

        // Update the session with the authorization code
        await this.authSessionRepository.update(authSession.id, {
            authorizationCode,
            status: "code_issued",
        });

        // If there's an issuer_state, also update the main session
        if (authSession.issuerState) {
            try {
                await this.sessionStore.updateForTenant(
                    authSession.tenantId,
                    authSession.issuerState,
                    {
                        authorization_code: authorizationCode,
                    },
                );
            } catch (error) {
                this.logger.warn(
                    "Could not update main session with authorization code:",
                    error,
                );
            }
        }

        return {
            status: "ok",
            code: authorizationCode,
        };
    }

    /**
     * Verify PKCE code_verifier against code_challenge.
     */
    private async verifyPkce(
        codeVerifier: string,
        codeChallenge: string,
        method?: string,
    ): Promise<boolean> {
        if (method === "S256" || !method) {
            const { createHash } = await import("node:crypto");
            const hash = createHash("sha256")
                .update(codeVerifier)
                .digest("base64url");
            return hash === codeChallenge;
        } else if (method === "plain") {
            return codeVerifier === codeChallenge;
        }
        return false;
    }

    /**
     * Mark a web authorization as completed.
     * Called when user completes web-based authorization.
     */
    async completeWebAuthorization(
        authSession: string,
        tenantId: string,
    ): Promise<boolean> {
        const result = await this.authSessionRepository.update(
            { authSession, tenantId },
            { status: "web_auth_completed" },
        );
        return (result.affected ?? 0) > 0;
    }

    /**
     * Create an error response.
     */
    createErrorResponse(
        error: string,
        errorDescription?: string,
    ): InteractiveAuthorizationResponse {
        return {
            error,
            error_description: errorDescription,
        };
    }
}
