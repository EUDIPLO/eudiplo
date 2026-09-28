import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import {
    type HttpMethod,
    type Jwk,
    Oauth2ResourceServer,
    SupportedAuthenticationScheme,
} from "@openid4vc/oauth2";
import {
    type CredentialResponse,
    DeferredCredentialResponse,
    type IssuerMetadataResult,
    Openid4vciIssuer,
} from "@openid4vc/openid4vci";
import { decodeJwt } from "jose";
import { Span, TraceService } from "nestjs-otel";
import { LessThan, Repository } from "typeorm";
import { v4 } from "uuid";
import { CryptoService } from "../../../crypto/crypto.service.js";
import type { SessionData as Session } from "../../../session/domain/session-data.js";
import { TrustStoreService } from "../../../trust/trust-store.service.js";
import { X509ValidationService } from "../../../trust/x509-validation.service.js";
import { IssuanceService } from "../../configuration/issuance/issuance.service.js";
import { CompleteDeferredCredential } from "./application/complete-deferred-credential.js";
import { FailDeferredCredential } from "./application/fail-deferred-credential.js";
import { ResolveDeferredCredentialRetrieval } from "./application/resolve-deferred-credential-retrieval.js";
import {
    validateAttestationProofTrust,
    validateJwtProofAttestationTrust,
} from "./attestation-proof-trust.util.js";
import { DPOP_PROOF_FRESHNESS } from "./authorization/shared/dpop.util.js";
import { DeferredTransactionStatus } from "./domain/deferred-transaction-status.js";
import { DeferredCredentialRequestDto } from "./dto/deferred-credential-request.dto.js";
import { DeferredTransactionEntity } from "./entities/deferred-transaction.entity.js";
import {
    CredentialRequestException,
    DeferredCredentialException,
} from "./exceptions/index.js";
import {
    CREDENTIAL_NONCE_REPOSITORY,
    type CredentialNonceRepository,
} from "./ports/credential-nonce.repository.js";
import type { DeferredTransactionData } from "./ports/deferred-transaction.repository.js";
import type { Oid4vciRequestContext } from "./request-context.js";
import { normalizeRequestHeaders } from "./util.js";

/**
 * Parameters for creating a deferred credential transaction.
 */
export interface CreateDeferredTransactionParams {
    /** The parsed credential request */
    parsedCredentialRequest: {
        proofType: "jwt" | "attestation";
        proofs: string[];
        credentialConfigurationId: string;
    };
    /** The session */
    session: Session;
    /** The tenant ID */
    tenantId: string;
    /** The interval for wallet polling (in seconds) */
    interval?: number;
    /** The issuer metadata */
    issuerMetadata: IssuerMetadataResult;
    /** Opaque access-token fingerprint for active-credential batch grouping */
    issuanceSetId?: string;
}

/**
 * Service for handling deferred credential issuance operations.
 * Manages the lifecycle of deferred transactions including creation,
 * retrieval, completion, and failure.
 */
@Injectable()
export class DeferredCredentialService {
    constructor(
        private readonly cryptoService: CryptoService,
        private readonly configService: ConfigService,
        private readonly issuanceService: IssuanceService,
        private readonly traceService: TraceService,
        private readonly trustStoreService: TrustStoreService,
        private readonly x509ValidationService: X509ValidationService,
        @Inject(CREDENTIAL_NONCE_REPOSITORY)
        private readonly nonceRepository: CredentialNonceRepository,
        @InjectRepository(DeferredTransactionEntity)
        private readonly deferredTransactionRepository: Repository<DeferredTransactionEntity>,
        private readonly resolveDeferredCredentialRetrieval: ResolveDeferredCredentialRetrieval,
        private readonly completeDeferredCredential: CompleteDeferredCredential,
        private readonly failDeferredCredential: FailDeferredCredential,
    ) {}

    /**
     * Get the OID4VCI issuer instance for a specific tenant.
     */
    private getIssuer(tenantId: string, sessionId?: string): Openid4vciIssuer {
        const callbacks = this.cryptoService.getCallbackContext(
            tenantId,
            sessionId,
        );
        return new Openid4vciIssuer({ callbacks });
    }

    /**
     * Get the OID4VCI resource server instance for a specific tenant.
     */
    private getResourceServer(
        tenantId: string,
        sessionId?: string,
    ): Oauth2ResourceServer {
        const callbacks = this.cryptoService.getCallbackContext(
            tenantId,
            sessionId,
        );
        return new Oauth2ResourceServer({ callbacks });
    }

    /**
     * Enforce that the presented access token is authorized for the deferred
     * credential's `credential_configuration_id`, per OID4VCI Section 6.
     * If the access token does not carry `authorization_details` (e.g.
     * scope-only external AS integrations), the check is skipped.
     */
    private enforceAuthorizationDetailsForDeferred(
        tokenPayload: Record<string, unknown>,
        requestedCredentialConfigurationId: string,
    ): void {
        const raw = tokenPayload.authorization_details;
        if (!Array.isArray(raw) || raw.length === 0) {
            return;
        }

        const authorized = raw
            .filter(
                (ad): ad is Record<string, unknown> =>
                    typeof ad === "object" &&
                    ad !== null &&
                    (ad as Record<string, unknown>).type ===
                        "openid_credential",
            )
            .map((ad) => ad.credential_configuration_id as string | undefined)
            .filter((id): id is string => typeof id === "string");

        if (!authorized.includes(requestedCredentialConfigurationId)) {
            throw new CredentialRequestException(
                "invalid_credential_request",
                `Access token is not authorized for credential_configuration_id '${requestedCredentialConfigurationId}'`,
            );
        }
    }

    /**
     * Create a deferred credential transaction.
     * Called when the webhook indicates that credential issuance should be deferred.
     *
     * @param params The parameters for creating the deferred transaction
     * @returns A deferred credential response with transaction_id and interval
     */
    @Span("oid4vci.createDeferredTransaction")
    async createDeferredTransaction(
        params: CreateDeferredTransactionParams,
    ): Promise<DeferredCredentialResponse> {
        const {
            parsedCredentialRequest,
            session,
            tenantId,
            interval = 5,
            issuerMetadata,
            issuanceSetId,
        } = params;

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": session.id,
            "session.tenantId": tenantId,
            "oid4vci.credentialConfigurationId":
                parsedCredentialRequest.credentialConfigurationId,
            "oid4vci.interval": interval,
        });

        const issuer = this.getIssuer(tenantId, session.id);

        if (parsedCredentialRequest.proofs.length !== 1) {
            throw new CredentialRequestException(
                "invalid_proof",
                "Deferred issuance requires exactly one key proof",
            );
        }

        // Verify the first proof to get the holder's public key
        const proof = parsedCredentialRequest.proofs[0];
        if (!proof) {
            throw new CredentialRequestException(
                "invalid_proof",
                "No key proof was provided for deferred issuance",
            );
        }

        const payload = decodeJwt(proof);
        const expectedNonce =
            typeof payload.nonce === "string" ? payload.nonce : undefined;
        if (!expectedNonce) {
            throw new CredentialRequestException(
                "invalid_proof",
                "Key proof must contain a nonce when deferred issuance is requested",
            );
        }

        // Delete the nonce to prevent reuse
        const nonceDeleted = await this.nonceRepository.delete(
            tenantId,
            expectedNonce,
        );
        if (!nonceDeleted) {
            throw new CredentialRequestException(
                "invalid_nonce",
                "The nonce in the key proof is invalid or has already been used",
            );
        }

        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);

        let holderCnf: Jwk;
        if (parsedCredentialRequest.proofType === "jwt") {
            const verifiedProof = await issuer.verifyCredentialRequestJwtProof({
                expectedNonce,
                issuerMetadata,
                jwt: proof,
            });
            await validateJwtProofAttestationTrust(
                proof,
                issuanceConfig.walletProviderTrustLists ?? [],
                {
                    tenantId,
                    trustStoreService: this.trustStoreService,
                    x509ValidationService: this.x509ValidationService,
                },
            );
            holderCnf = verifiedProof.signer.publicJwk as Jwk;
        } else {
            const verifiedAttestation =
                await issuer.verifyCredentialRequestAttestationProof({
                    expectedNonce,
                    issuerMetadata,
                    keyAttestationJwt: proof,
                });

            await validateAttestationProofTrust(
                proof,
                issuanceConfig.walletProviderTrustLists ?? [],
                {
                    tenantId,
                    trustStoreService: this.trustStoreService,
                    x509ValidationService: this.x509ValidationService,
                },
            );

            const attestedKeys = verifiedAttestation.payload
                .attested_keys as Jwk[];
            if (!Array.isArray(attestedKeys) || attestedKeys.length === 0) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    "Attestation proof does not contain any attested keys",
                );
            }
            if (attestedKeys.length !== 1) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    "Deferred issuance supports exactly one attested key",
                );
            }
            holderCnf = attestedKeys[0] as Jwk;
        }

        const transactionId = v4();

        // Calculate expiration (default 24 hours)
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        // Create deferred transaction record
        const deferredTransaction = this.deferredTransactionRepository.create({
            transactionId,
            tenantId,
            sessionId: session.id,
            credentialConfigurationId:
                parsedCredentialRequest.credentialConfigurationId,
            issuanceSetId,
            holderCnf: holderCnf as Record<string, unknown>,
            status: DeferredTransactionStatus.Pending,
            interval,
            expiresAt,
        });

        await this.deferredTransactionRepository.save(deferredTransaction);

        return {
            transaction_id: transactionId,
            interval,
        };
    }

    /**
     * Handle deferred credential request.
     * Called when wallet polls with transaction_id.
     *
     * @param req The request
     * @param body The deferred credential request DTO
     * @param tenantId The tenant ID
     * @param issuerMetadata The issuer metadata
     * @returns Credential response or throws issuance_pending error
     */
    @Span("oid4vci.getDeferredCredentialInternal")
    async getDeferredCredential(
        req: Oid4vciRequestContext,
        body: DeferredCredentialRequestDto,
        tenantId: string,
        issuerMetadata: IssuerMetadataResult,
    ): Promise<CredentialResponse> {
        const resourceServer = this.getResourceServer(tenantId);
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const headers = normalizeRequestHeaders(req.headers);

        const allowedAuthenticationSchemes = [
            SupportedAuthenticationScheme.DPoP,
        ];

        if (!issuanceConfig.dPopRequired) {
            allowedAuthenticationSchemes.push(
                SupportedAuthenticationScheme.Bearer,
            );
        }

        // Verify the access token
        const { tokenPayload } = await resourceServer.verifyResourceRequest({
            authorizationServers: issuerMetadata.authorizationServers,
            request: {
                url: `${this.configService.getOrThrow<string>("PUBLIC_URL")}${req.url}`,
                method: req.method as HttpMethod,
                headers,
            },
            resourceServer: issuerMetadata.credentialIssuer.credential_issuer,
            allowedAuthenticationSchemes,
            dpop: DPOP_PROOF_FRESHNESS,
        });

        // Find the deferred transaction
        const deferredTransaction =
            await this.deferredTransactionRepository.findOneBy({
                transactionId: body.transaction_id,
                tenantId,
            });

        if (!deferredTransaction) {
            throw new DeferredCredentialException(
                "invalid_transaction_id",
                "The transaction_id is invalid or has expired",
            );
        }

        // Enforce that the access token is authorized for this deferred
        // credential's configuration, per OID4VCI Section 6. When the token
        // carries `authorization_details`, the deferred credential's
        // configuration MUST be one of the authorized ones.
        this.enforceAuthorizationDetailsForDeferred(
            tokenPayload as Record<string, unknown>,
            deferredTransaction.credentialConfigurationId,
        );

        // Add session context to span for trace correlation
        const span = this.traceService.getSpan();
        span?.setAttributes({
            "session.id": deferredTransaction.sessionId,
            "session.tenantId": tenantId,
            "oid4vci.transactionId": deferredTransaction.transactionId,
            "oid4vci.status": deferredTransaction.status,
            "oid4vci.credentialConfigurationId":
                deferredTransaction.credentialConfigurationId,
        });

        const retrieval = this.resolveDeferredCredentialRetrieval.execute({
            status: deferredTransaction.status,
            interval: deferredTransaction.interval,
            expiresAt: deferredTransaction.expiresAt,
            credential: deferredTransaction.credential,
            errorMessage: deferredTransaction.errorMessage,
        });

        if (retrieval.kind === "expire") {
            await this.deferredTransactionRepository.update(
                { transactionId: body.transaction_id },
                { status: DeferredTransactionStatus.Expired },
            );
            throw new DeferredCredentialException(
                "invalid_transaction_id",
                "The transaction has expired",
            );
        }

        switch (retrieval.kind) {
            case "pending":
                throw new DeferredCredentialException(
                    "issuance_pending",
                    "The credential issuance is still pending",
                    retrieval.interval,
                );
            case "failed":
                throw new DeferredCredentialException(
                    "invalid_transaction_id",
                    retrieval.message,
                );
            case "expired":
            case "retrieved":
                throw new DeferredCredentialException(
                    "invalid_transaction_id",
                    retrieval.message,
                );
            case "ready":
                // Mark as retrieved
                await this.deferredTransactionRepository.update(
                    { transactionId: body.transaction_id },
                    { status: DeferredTransactionStatus.Retrieved },
                );

                return {
                    credential: retrieval.credential,
                } as CredentialResponse;
        }
    }

    /**
     * Mark a deferred transaction as ready with the issued credential.
     * This method is called when the external system completes processing.
     *
     * @param tenantId The tenant ID
     * @param transactionId The transaction ID
     * @param claims The claims to include in the credential
     * @returns The updated deferred transaction or null if not found
     */
    async completeDeferredTransaction(
        tenantId: string,
        transactionId: string,
        claims: Record<string, unknown>,
    ): Promise<DeferredTransactionData | null> {
        return this.completeDeferredCredential.execute({
            tenantId,
            transactionId,
            claims,
        });
    }

    /**
     * Mark a deferred transaction as failed.
     *
     * @param tenantId The tenant ID
     * @param transactionId The transaction ID
     * @param errorMessage Optional error message
     * @returns The updated deferred transaction or null if not found
     */
    async failDeferredTransaction(
        tenantId: string,
        transactionId: string,
        errorMessage?: string,
    ): Promise<DeferredTransactionData | null> {
        return this.failDeferredCredential.execute(
            tenantId,
            transactionId,
            errorMessage,
        );
    }

    /**
     * Cleanup expired deferred transactions.
     * Runs hourly via cron job.
     */
    @Cron(CronExpression.EVERY_HOUR)
    async cleanupExpiredDeferredTransactions(): Promise<void> {
        await this.deferredTransactionRepository.delete({
            expiresAt: LessThan(new Date()),
        });
    }
}
