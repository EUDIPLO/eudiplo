import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import {
    CreateCredentialResponseReturn,
    type CredentialRequest,
    type CredentialResponse,
    DeferredCredentialResponse,
    type IssuerMetadataResult,
    type Openid4vciIssuer,
    ParseCredentialRequestReturn,
} from "@openid4vc/openid4vci";
import { Span, TraceService } from "nestjs-otel";
import { v4 } from "uuid";
import { EncryptionService } from "../../../crypto/encryption/encryption.service.js";
import { SessionStore } from "../../../session/application/session-store.js";
import { SessionStatus } from "../../../session/domain/session-state.js";
import { AuditLogContext } from "../../../session/logging/session-audit.service.js";
import { SessionLoggerService } from "../../../session/logging/session-logger.service.js";
import { CredentialsService } from "../../configuration/credentials/credentials.service.js";
import { CredentialClaimsResolutionError } from "../../configuration/credentials/domain/credential-claims.js";
import { InvalidCredentialClaims } from "../../configuration/credentials/domain/credential-claims-validation.js";
import { CredentialProofType } from "../../configuration/credentials/entities/credential.entity.js";
import { InvalidClaimsException } from "../../configuration/credentials/exceptions/invalid-claims.exception.js";
import { IssuanceService } from "../../configuration/issuance/issuance.service.js";
import { SubjectKeyService } from "../../status-list/subject-key.service.js";
import { addLegacyCredentialResponseEncryptionAlg } from "./adapters/credential-request-compat.js";
import { BuildIssuerMetadata } from "./application/build-issuer-metadata.js";
import { CredentialSessionAuthorizationDenied } from "./application/correlate-credential-token-session.js";
import { CreateCredentialOffer } from "./application/create-credential-offer.js";
import { HandleCredentialNotification } from "./application/handle-credential-notification.js";
import { IssueCredentialsFromProofs } from "./application/issue-credentials-from-proofs.js";
import { CredentialNotificationNotFound } from "./application/record-credential-notification.js";
import {
    CredentialAuthorizationError,
    ResolveAuthorizedCredentialConfiguration,
} from "./application/resolve-authorized-credential-configuration.js";
import {
    CredentialProofResolutionError,
    ResolveCredentialProofs,
} from "./application/resolve-credential-proofs.js";
import { ResolveCredentialSession } from "./application/resolve-credential-session.js";
import {
    type CredentialAccessTokenPayload,
    CredentialAccessTokenVerifier,
} from "./credential-access-token.verifier.js";
import { DeferredCredentialService } from "./deferred-credential.service.js";
import { AuthorizationServerError } from "./domain/authorization-server-errors.js";
import { InvalidCredentialOffer } from "./domain/credential-offer-errors.js";
import { InvalidCredentialProof } from "./domain/credential-proof-errors.js";
import { DeferredCredentialRequestDto } from "./dto/deferred-credential-request.dto.js";
import { NotificationRequestDto } from "./dto/notification-request.dto.js";
import { OfferRequestDto, OfferResponse } from "./dto/offer-request.dto.js";
import { CredentialRequestException } from "./exceptions/index.js";
import { NonceService } from "./nonce.service.js";
import { Oid4vciSdkFactory } from "./oid4vci-sdk.factory.js";
import type { Oid4vciRequestContext } from "./request-context.js";

type SupportedCredentialProofType = "jwt" | "attestation";

interface ParsedCredentialProofs {
    proofType: SupportedCredentialProofType;
    values: string[];
}

/**
 * Service for handling OID4VCI (OpenID 4 Verifiable Credential Issuance) operations.
 */
@Injectable()
export class Oid4vciService {
    private readonly logger = new Logger(Oid4vciService.name);
    constructor(
        private readonly sdk: Oid4vciSdkFactory,
        private readonly buildIssuerMetadata: BuildIssuerMetadata,
        private readonly accessTokens: CredentialAccessTokenVerifier,
        private readonly credentialsService: CredentialsService,
        private readonly sessionStore: SessionStore,
        private readonly handleCredentialNotification: HandleCredentialNotification,
        private readonly createCredentialOffer: CreateCredentialOffer,
        private readonly resolveAuthorizedCredentialConfiguration: ResolveAuthorizedCredentialConfiguration,
        private readonly resolveCredentialSession: ResolveCredentialSession,
        private readonly resolveCredentialProofs: ResolveCredentialProofs,
        private readonly issueCredentialsFromProofs: IssueCredentialsFromProofs,
        private readonly auditLogger: SessionLoggerService,
        private readonly issuanceService: IssuanceService,
        private readonly deferredCredentialService: DeferredCredentialService,
        private readonly traceService: TraceService,
        private readonly encryptionService: EncryptionService,
        private readonly nonceService: NonceService,
        private readonly subjectKeyService: SubjectKeyService,
    ) {}

    /**
     * Create a credential offer for a tenant.
     * @param tenantId The ID of the tenant.
     * @param body The request body containing the offer details.
     * @returns The created credential offer.
     */
    @Span("oid4vci.createOffer")
    async createOffer(
        tenantId: string,
        body: OfferRequestDto,
    ): Promise<OfferResponse> {
        try {
            return await this.createCredentialOffer.execute(tenantId, body);
        } catch (error) {
            if (error instanceof InvalidCredentialOffer)
                throw new ConflictException(error.message);
            throw toHttpError(error);
        }
    }

    /**
     * Build the issuer metadata; authorization-server problems become 400.
     */
    private async issuerMetadata(
        tenantId: string,
        issuer: Openid4vciIssuer,
    ): Promise<IssuerMetadataResult> {
        try {
            return await this.buildIssuerMetadata.execute(tenantId, issuer);
        } catch (error) {
            throw toHttpError(error);
        }
    }

    private async resolveSessionAndClaims(
        tokenPayload: CredentialAccessTokenPayload,
        tenantId: string,
        credentialConfigurationId: string,
    ) {
        try {
            return await this.resolveCredentialSession.execute(
                tenantId,
                credentialConfigurationId,
                tokenPayload,
            );
        } catch (error) {
            if (error instanceof CredentialClaimsResolutionError)
                throw new ConflictException(error.message);
            if (error instanceof CredentialSessionAuthorizationDenied)
                throw new CredentialRequestException(
                    "credential_request_denied",
                    error.message,
                );
            throw error;
        }
    }

    private async deriveIssuanceSetId(
        request: Oid4vciRequestContext,
    ): Promise<string> {
        const authorization = request.headers.authorization;
        const header = Array.isArray(authorization)
            ? authorization[0]
            : authorization;
        const accessToken = header?.trim().split(/\s+/, 2)[1];
        if (!accessToken) {
            throw new CredentialRequestException(
                "invalid_credential_request",
                "Credential request is missing an access token",
            );
        }
        return this.subjectKeyService.deriveIssuanceSetId(accessToken);
    }

    /**
     * Map generic errors to OID4VCI-compliant credential request exceptions.
     */
    private mapToCredentialRequestException(error: unknown): never {
        if (error instanceof CredentialRequestException) {
            throw error;
        }
        // Resolved claims that do not match the credential configuration;
        // the message names claim paths only, never claim values.
        if (
            error instanceof InvalidClaimsException ||
            error instanceof InvalidCredentialClaims
        ) {
            throw new CredentialRequestException(
                "credential_request_denied",
                error.message,
            );
        }
        if (error instanceof InvalidCredentialProof) {
            throw new CredentialRequestException(
                "invalid_proof",
                error.message,
            );
        }

        if (
            error instanceof ConflictException &&
            (error.message?.includes("not found") ||
                error.message?.includes("Credential configuration"))
        ) {
            throw new CredentialRequestException(
                "unknown_credential_configuration",
                error.message,
            );
        }

        if (
            error instanceof Error &&
            (error.message?.toLowerCase().includes("proof") ||
                error.message?.toLowerCase().includes("signature") ||
                error.message?.toLowerCase().includes("jwt"))
        ) {
            throw new CredentialRequestException(
                "invalid_proof",
                error.message,
            );
        }

        throw new CredentialRequestException(
            "credential_request_denied",
            error instanceof Error
                ? error.message
                : "An unexpected error occurred",
        );
    }

    private async enforceProofTypePolicy(
        tenantId: string,
        credentialConfigurationId: string,
        proofType: SupportedCredentialProofType,
    ): Promise<void> {
        const supportedProofTypes =
            await this.credentialsService.getSupportedProofTypesForCredentialConfig(
                tenantId,
                credentialConfigurationId,
            );

        if (!supportedProofTypes.includes(proofType as CredentialProofType)) {
            throw new CredentialRequestException(
                "invalid_proof",
                `Proof type '${proofType}' is not supported for credential_configuration_id '${credentialConfigurationId}'`,
            );
        }
    }

    /**
     * Get a credential for a specific session.
     * @param req The incoming HTTP request
     * @param tenantId The tenant identifier
     * @returns The credential response or deferred response
     */
    @Span("oid4vci.getCredential")
    async getCredential(
        req: Oid4vciRequestContext,
        tenantId: string,
    ): Promise<CreateCredentialResponseReturn | DeferredCredentialResponse> {
        const issuer = this.sdk.issuer(tenantId);
        const issuerMetadata = await this.issuerMetadata(tenantId, issuer);
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        // Parse and validate the credential request
        const known = issuer.getKnownCredentialConfigurationsSupported(
            issuerMetadata.credentialIssuer,
        );
        issuerMetadata.knownCredentialConfigurations = known;

        // Decrypt encrypted credential request (JWE) if Content-Type is application/jwt
        const rawBody = req.body;
        const contentType = req.contentType;
        const isJwtContentType =
            contentType.startsWith("application/jwt") ||
            contentType.startsWith(
                "application/openid4vci-credential-request+jwt",
            );

        this.logger.debug(
            `[${tenantId}] OID4VCI credential request received: encrypted=${isJwtContentType || typeof rawBody === "string"}, contentType=${contentType || "missing"}`,
        );

        let requestBody: CredentialRequest;
        if (isJwtContentType || typeof rawBody === "string") {
            // Encrypted credential request - need to read and decrypt JWE
            let jweString: string;
            if (typeof rawBody === "string") {
                // Text body parser successfully set req.body as string
                jweString = rawBody;
            } else {
                // Body parser did not consume the stream for non-JSON content types;
                // read raw body from the request stream directly as a fallback.
                throw new CredentialRequestException(
                    "invalid_encryption_parameters",
                    "Encrypted credential request body is empty",
                );
            }
            try {
                requestBody =
                    await this.encryptionService.decryptJweToJson<CredentialRequest>(
                        jweString,
                        tenantId,
                    );
            } catch {
                throw new CredentialRequestException(
                    "invalid_encryption_parameters",
                    "Failed to decrypt encrypted credential request",
                );
            }
        } else if (rawBody && typeof rawBody === "object") {
            requestBody = rawBody as CredentialRequest;
        } else {
            throw new CredentialRequestException(
                "invalid_credential_request",
                "Credential request body is missing or malformed",
            );
        }

        // Validate credential_configuration_id before parsing to return spec-compliant error code
        const requestedConfigId = requestBody.credential_configuration_id as
            | string
            | undefined;
        if (requestedConfigId && !known[requestedConfigId]) {
            throw new CredentialRequestException(
                "unknown_credential_configuration",
                `Credential configuration '${requestedConfigId}' is not supported`,
            );
        }

        // Validate encryption parameters before parsing to return spec-compliant error code
        const encryptionParams = requestBody.credential_response_encryption;
        if (encryptionParams) {
            const supportedAlg =
                issuerMetadata.credentialIssuer.credential_response_encryption
                    ?.alg_values_supported ?? [];
            const supportedEnc =
                issuerMetadata.credentialIssuer.credential_response_encryption
                    ?.enc_values_supported ?? [];

            if (
                typeof encryptionParams.jwk.alg !== "string" ||
                !supportedAlg.includes(encryptionParams.jwk.alg)
            ) {
                throw new CredentialRequestException(
                    "invalid_encryption_parameters",
                    `Unsupported credential response encryption algorithm '${encryptionParams.jwk.alg ?? "undefined"}'. Supported: ${supportedAlg.join(", ")}`,
                );
            }
            if (
                typeof encryptionParams.enc !== "string" ||
                !supportedEnc.includes(encryptionParams.enc)
            ) {
                throw new CredentialRequestException(
                    "invalid_encryption_parameters",
                    `Unsupported credential response encryption encoding '${encryptionParams.enc ?? "undefined"}'. Supported: ${supportedEnc.join(", ")}`,
                );
            }
        }

        let parsedCredentialRequest: ParseCredentialRequestReturn;
        try {
            parsedCredentialRequest = issuer.parseCredentialRequest({
                issuerMetadata,
                credentialRequest:
                    addLegacyCredentialResponseEncryptionAlg(requestBody),
            });
        } catch (err) {
            throw new CredentialRequestException(
                "invalid_credential_request",
                err instanceof Error
                    ? err.message
                    : "The Credential Request is malformed or missing required parameters",
            );
        }

        let parsedProofs: ParsedCredentialProofs;
        try {
            parsedProofs = this.resolveCredentialProofs.execute(
                parsedCredentialRequest?.proofs,
            );
        } catch (error) {
            if (error instanceof CredentialProofResolutionError) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    error.message,
                );
            }
            throw error;
        }

        this.logger.debug(
            `[${tenantId}] OID4VCI credential request parsed: proofType=${parsedProofs.proofType}, proofCount=${parsedProofs.values.length}, hasResponseEncryption=${!!requestBody.credential_response_encryption}`,
        );

        // Verify access token
        const tokenPayload = await this.accessTokens.verify(
            req,
            tenantId,
            issuerMetadata,
            issuanceConfig.dPopRequired,
        );
        const issuanceSetId = await this.deriveIssuanceSetId(req);

        // Resolve credentialConfigurationId from either:
        //  - credential_identifier (OID4VCI Final Section 8.2): look it up in the
        //    token's authorization_details[].credential_identifiers to find the
        //    matching credential_configuration_id.
        //  - credential_configuration_id (direct)
        let credentialConfigurationId: string;
        try {
            credentialConfigurationId =
                this.resolveAuthorizedCredentialConfiguration.execute({
                    credentialIdentifier:
                        parsedCredentialRequest.credentialIdentifier as
                            | string
                            | undefined,
                    credentialConfigurationId:
                        parsedCredentialRequest.credentialConfigurationId as
                            | string
                            | undefined,
                    authorizationDetails: tokenPayload.authorization_details,
                });
        } catch (error) {
            if (error instanceof CredentialAuthorizationError) {
                throw new CredentialRequestException(error.code, error.message);
            }
            throw error;
        }

        try {
            await this.enforceProofTypePolicy(
                tenantId,
                credentialConfigurationId,
                parsedProofs.proofType,
            );
        } catch (error) {
            this.mapToCredentialRequestException(error);
        }

        const { session, claimsResult, isExternalAsToken, isChainedAsToken } =
            await this.resolveSessionAndClaims(
                tokenPayload,
                tenantId,
                credentialConfigurationId,
            );

        this.logger.debug(
            `[${tenantId}] OID4VCI credential request authorized: sessionId=${session.id}, credentialConfigurationId=${credentialConfigurationId}, deferred=${!!claimsResult?.deferred}, externalAs=${isExternalAsToken}, chainedAs=${isChainedAsToken}`,
        );

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "oid4vci.credentialConfigurationId": credentialConfigurationId,
            "oid4vci.proofCount": parsedProofs.values.length,
            "oid4vci.proofType": parsedProofs.proofType,
            "oid4vci.isExternalAs": isExternalAsToken,
            "oid4vci.isChainedAs": isChainedAsToken,
        });

        // Create session logging context
        const logContext: AuditLogContext = {
            sessionId: session.id,
            tenantId,
            flowType: "OID4VCI",
            stage: "credential_request",
        };

        this.auditLogger.logFlowStart(logContext, {
            credentialConfigurationId,
            proofCount: parsedProofs.values.length,
            proofType: parsedProofs.proofType,
            isExternalAs: isExternalAsToken,
            isChainedAs: isChainedAsToken,
        });

        try {
            // Check if the webhook indicated deferred issuance
            if (claimsResult?.deferred) {
                // Deliberately not routed through the credential error mapper
                // below; only authorization-server errors are translated.
                return this.deferredCredentialService
                    .createDeferredTransaction({
                        parsedCredentialRequest: {
                            proofs: parsedProofs.values,
                            proofType: parsedProofs.proofType,
                            credentialConfigurationId,
                        },
                        session,
                        tenantId,
                        interval: claimsResult.interval,
                        issuanceSetId,
                    })
                    .catch((error: unknown) => {
                        throw toHttpError(error);
                    });
            }

            // Validate and consume nonces
            await this.nonceService.validateAndConsume(
                parsedProofs.values,
                parsedProofs.proofType,
                tenantId,
                logContext,
                credentialConfigurationId,
            );

            // Issue credentials for each proof
            const credentials = await this.issueCredentialsFromProofs.execute({
                proofs: parsedProofs.values,
                proofType: parsedProofs.proofType,
                session,
                credentialConfigurationId,
                claims: claimsResult?.claims,
                issuanceSetId,
                batchSize: issuanceConfig.batchSize,
                trustLists: issuanceConfig.walletProviderTrustLists ?? [],
                onIssued: (credentialSize) =>
                    this.auditLogger.logCredentialIssuance(
                        logContext,
                        credentialConfigurationId,
                        { credentialSize, proofVerified: true },
                    ),
            });

            this.logger.debug(
                `[${tenantId}] OID4VCI credentials issued: sessionId=${session.id}, credentialConfigurationId=${credentialConfigurationId}, credentialCount=${credentials.length}`,
            );

            // Update session with notification
            const notificationId = v4();
            session.notifications.push({
                id: notificationId,
                credentialConfigurationId,
            });
            await this.sessionStore.updateForTenant(
                session.tenantId,
                session.id,
                {
                    notifications: session.notifications,
                    status: SessionStatus.Fetched,
                },
            );

            this.auditLogger.logFlowComplete(logContext, {
                credentialsIssued: credentials.length,
                notificationId,
            });

            return issuer.createCredentialResponse({
                credentials,
                credentialRequest: parsedCredentialRequest,
                cNonce: tokenPayload.nonce as string,
                notificationId,
                credentialResponseEncryption:
                    parsedCredentialRequest.credentialResponseEncryption,
            });
        } catch (error) {
            this.logger.warn(
                `[${tenantId}] OID4VCI credential request failed: sessionId=${session.id}, credentialConfigurationId=${credentialConfigurationId}, error=${error instanceof Error ? error.message : "unknown"}`,
            );
            this.auditLogger.logFlowError(logContext, error as Error, {
                credentialConfigurationId,
            });
            this.mapToCredentialRequestException(error);
        }
    }

    /**
     * Store the notification in the session based on the notitification id.
     * @param req
     * @param body
     */
    @Span("oid4vci.handleNotification")
    async handleNotification(
        req: Oid4vciRequestContext,
        body: NotificationRequestDto,
        tenantId: string,
    ) {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        if (issuanceConfig.notificationEndpointEnabled === false) {
            throw new NotFoundException(
                "Notification endpoint is disabled for this issuance config",
            );
        }

        const issuerMetadata = await this.issuerMetadata(
            tenantId,
            this.sdk.issuer(tenantId),
        );
        const tokenPayload = await this.accessTokens.verify(
            req,
            tenantId,
            issuerMetadata,
            issuanceConfig.dPopRequired,
        );

        const session = await this.sessionStore.getForTenant(
            tenantId,
            tokenPayload.sub,
        );

        if (session.id !== tokenPayload.sub) {
            throw new BadRequestException("Session not found");
        }

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": session.tenantId,
            "oid4vci.notificationId": body.notification_id,
            "oid4vci.event": body.event ?? "",
        });

        // Create session logging context
        const logContext: AuditLogContext = {
            sessionId: session.id,
            tenantId,
            flowType: "OID4VCI",
            stage: "notification",
        };

        try {
            await this.handleCredentialNotification.execute(
                session,
                body.notification_id,
                body.event,
            );
        } catch (error) {
            this.auditLogger.logError(
                logContext,
                error as Error,
                "Failed to handle notification",
                {
                    notificationId: body.notification_id,
                },
            );
            if (error instanceof CredentialNotificationNotFound) {
                throw new BadRequestException(
                    "No notifications found in session",
                );
            }
            throw error;
        }
    }

    /**
     * Handle deferred credential request.
     * Called when wallet polls with transaction_id.
     * @param req The request
     * @param body The deferred credential request DTO
     * @param tenantId The tenant ID
     * @returns Credential response or issuance_pending error
     */
    @Span("oid4vci.getDeferredCredential")
    async getDeferredCredential(
        req: Oid4vciRequestContext,
        body: DeferredCredentialRequestDto,
        tenantId: string,
    ): Promise<CredentialResponse> {
        // Add context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "oid4vci.transactionId": body.transaction_id,
            "session.tenantId": tenantId,
        });

        const issuerMetadata = await this.issuerMetadata(
            tenantId,
            this.sdk.issuer(tenantId),
        );
        return this.deferredCredentialService.getDeferredCredential(
            req,
            body,
            tenantId,
            issuerMetadata,
        );
    }
}

/** Authorization-server configuration and discovery problems are client errors. */
function toHttpError(error: unknown): unknown {
    return error instanceof AuthorizationServerError
        ? new BadRequestException(error.message)
        : error;
}
