import { Inject, Injectable } from "@nestjs/common";
import type { Jwk } from "@openid4vc/oauth2";
import type {
    CredentialResponse,
    DeferredCredentialResponse,
    IssuerMetadataResult,
} from "@openid4vc/openid4vci";
import { decodeJwt } from "jose";
import { Span, TraceService } from "nestjs-otel";
import { v4 } from "uuid";
import type { SessionData as Session } from "../../../session/domain/session-data.js";
import { IssuanceService } from "../../configuration/issuance/issuance.service.js";
import { CorrelateCredentialTokenSession } from "./application/correlate-credential-token-session.js";
import {
    CredentialAuthorizationError,
    ResolveAuthorizedCredentialConfiguration,
} from "./application/resolve-authorized-credential-configuration.js";
import { ResolveDeferredCredentialRetrieval } from "./application/resolve-deferred-credential-retrieval.js";
import { CredentialAccessTokenVerifier } from "./credential-access-token.verifier.js";
import { DeferredTransactionStatus } from "./domain/deferred-transaction-status.js";
import { DeferredCredentialRequestDto } from "./dto/deferred-credential-request.dto.js";
import {
    CredentialRequestException,
    DeferredCredentialException,
} from "./exceptions/index.js";
import {
    CREDENTIAL_NONCE_REPOSITORY,
    type CredentialNonceRepository,
} from "./ports/credential-nonce.repository.js";
import {
    CREDENTIAL_PROOF_VERIFIER,
    type CredentialProofVerifier,
} from "./ports/credential-proof-verifier.js";
import {
    DEFERRED_TRANSACTION_REPOSITORY,
    type DeferredTransactionRepository,
} from "./ports/deferred-transaction.repository.js";
import type { Oid4vciRequestContext } from "./request-context.js";

/** Lifetime of a deferred transaction. */
const DEFERRED_TRANSACTION_TTL_HOURS = 24;

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
    /** Opaque access-token fingerprint for active-credential batch grouping */
    issuanceSetId?: string;
}

/**
 * Wallet-facing part of deferred issuance (OID4VCI Section 9): creating a
 * transaction when claims are deferred, and serving the deferred credential
 * endpoint. Completing or failing a transaction is done by the
 * `CompleteDeferredCredential` and `FailDeferredCredential` use cases.
 */
@Injectable()
export class DeferredCredentialService {
    constructor(
        private readonly issuanceService: IssuanceService,
        private readonly traceService: TraceService,
        private readonly accessTokens: CredentialAccessTokenVerifier,
        @Inject(CREDENTIAL_NONCE_REPOSITORY)
        private readonly nonceRepository: CredentialNonceRepository,
        @Inject(CREDENTIAL_PROOF_VERIFIER)
        private readonly proofVerifier: CredentialProofVerifier,
        @Inject(DEFERRED_TRANSACTION_REPOSITORY)
        private readonly transactions: DeferredTransactionRepository,
        private readonly resolveDeferredCredentialRetrieval: ResolveDeferredCredentialRetrieval,
        private readonly resolveAuthorizedCredentialConfiguration: ResolveAuthorizedCredentialConfiguration,
        private readonly tokenSessions: CorrelateCredentialTokenSession,
    ) {}

    /**
     * Create a deferred credential transaction.
     * Called when the claims provider indicates that issuance should be deferred.
     * Consumes the proof nonce, verifies the single key proof and stores the
     * holder key for later issuance.
     *
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
            issuanceSetId,
        } = params;

        this.traceService.getSpan()?.setAttributes({
            "session.id": session.id,
            "session.tenantId": tenantId,
            "oid4vci.credentialConfigurationId":
                parsedCredentialRequest.credentialConfigurationId,
            "oid4vci.interval": interval,
        });

        if (parsedCredentialRequest.proofs.length !== 1) {
            throw new CredentialRequestException(
                "invalid_proof",
                "Deferred issuance requires exactly one key proof",
            );
        }

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
        const verifier = await this.proofVerifier.prepare(
            tenantId,
            issuanceConfig.walletProviderTrustLists ?? [],
        );
        const holderKeys = await verifier.verify(
            proof,
            parsedCredentialRequest.proofType,
        );
        if (parsedCredentialRequest.proofType === "attestation") {
            if (!Array.isArray(holderKeys) || holderKeys.length === 0) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    "Attestation proof does not contain any attested keys",
                );
            }
            if (holderKeys.length !== 1) {
                throw new CredentialRequestException(
                    "invalid_proof",
                    "Deferred issuance supports exactly one attested key",
                );
            }
        }
        const holderCnf = holderKeys[0] as Jwk;

        const transactionId = v4();
        const expiresAt = new Date();
        expiresAt.setHours(
            expiresAt.getHours() + DEFERRED_TRANSACTION_TTL_HOURS,
        );

        await this.transactions.create({
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

        return {
            transaction_id: transactionId,
            interval,
        };
    }

    /**
     * Handle deferred credential request.
     * Called when wallet polls with transaction_id.
     *
     * @returns Credential response or throws issuance_pending error
     */
    @Span("oid4vci.getDeferredCredentialInternal")
    async getDeferredCredential(
        req: Oid4vciRequestContext,
        body: DeferredCredentialRequestDto,
        tenantId: string,
        issuerMetadata: IssuerMetadataResult,
    ): Promise<CredentialResponse> {
        const issuanceConfig =
            await this.issuanceService.getIssuanceConfiguration(tenantId);
        const tokenPayload = await this.accessTokens.verify(
            req,
            tenantId,
            issuerMetadata,
            issuanceConfig.dPopRequired,
        );

        const transaction = await this.transactions.find(
            tenantId,
            body.transaction_id,
        );
        // The token must belong to the session that created the transaction.
        // A mismatch is reported like an unknown id so that transaction ids
        // of other sessions cannot be probed.
        if (
            !transaction ||
            !(await this.tokenSessions.belongsToSession(
                tenantId,
                tokenPayload,
                transaction.sessionId,
            ))
        ) {
            throw new DeferredCredentialException(
                "invalid_transaction_id",
                "The transaction_id is invalid or has expired",
            );
        }

        // OID4VCI Section 6: when the token carries `authorization_details`,
        // the deferred credential's configuration must be one of them.
        try {
            this.resolveAuthorizedCredentialConfiguration.execute({
                credentialConfigurationId:
                    transaction.credentialConfigurationId,
                authorizationDetails: tokenPayload.authorization_details,
            });
        } catch (error) {
            if (error instanceof CredentialAuthorizationError) {
                throw new CredentialRequestException(error.code, error.message);
            }
            throw error;
        }

        this.traceService.getSpan()?.setAttributes({
            "session.id": transaction.sessionId,
            "session.tenantId": tenantId,
            "oid4vci.transactionId": transaction.transactionId,
            "oid4vci.status": transaction.status,
            "oid4vci.credentialConfigurationId":
                transaction.credentialConfigurationId,
        });

        const retrieval = this.resolveDeferredCredentialRetrieval.execute({
            status: transaction.status,
            interval: transaction.interval,
            expiresAt: transaction.expiresAt,
            credential: transaction.credential,
            errorMessage: transaction.errorMessage,
        });

        switch (retrieval.kind) {
            case "expire":
                await this.transactions.markExpired(
                    tenantId,
                    body.transaction_id,
                );
                throw new DeferredCredentialException(
                    "invalid_transaction_id",
                    "The transaction has expired",
                );
            case "pending":
                throw new DeferredCredentialException(
                    "issuance_pending",
                    "The credential issuance is still pending",
                    retrieval.interval,
                );
            case "failed":
            case "expired":
            case "retrieved":
            case "unavailable":
                throw new DeferredCredentialException(
                    "invalid_transaction_id",
                    retrieval.message,
                );
            case "ready":
                if (
                    !(await this.transactions.markRetrieved(
                        tenantId,
                        body.transaction_id,
                    ))
                ) {
                    throw new DeferredCredentialException(
                        "invalid_transaction_id",
                        "The credential has already been retrieved",
                    );
                }
                return {
                    credential: retrieval.credential,
                } as CredentialResponse;
        }
    }
}
