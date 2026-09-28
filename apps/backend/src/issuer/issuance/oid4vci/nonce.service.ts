import { Inject, Injectable } from "@nestjs/common";
import { v4 } from "uuid";
import { AuditLogContext } from "../../../session/logging/session-audit.service.js";
import { SessionLoggerService } from "../../../session/logging/session-logger.service.js";
import {
    CredentialNonceValidationError,
    ValidateAndConsumeCredentialNonces,
} from "./application/validate-and-consume-credential-nonces.js";
import { CredentialRequestException } from "./exceptions/index.js";
import {
    CREDENTIAL_NONCE_REPOSITORY,
    type CredentialNonceRepository,
} from "./ports/credential-nonce.repository.js";

type SupportedCredentialProofType = "jwt" | "attestation";

/** Owns the complete lifecycle of OID4VCI proof nonces. */
@Injectable()
export class NonceService {
    constructor(
        @Inject(CREDENTIAL_NONCE_REPOSITORY)
        private readonly nonceRepository: CredentialNonceRepository,
        private readonly validateAndConsumeCredentialNonces: ValidateAndConsumeCredentialNonces,
        private readonly auditLogger: SessionLoggerService,
    ) {}

    async issue(tenantId: string): Promise<string> {
        const nonce = v4();
        await this.nonceRepository.save({
            nonce,
            tenantId,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
        return nonce;
    }

    /**
     * Validates all proof nonces and consumes them before credential issuance.
     * A nonce is tenant-scoped, time-limited, and single-use.
     */
    async validateAndConsume(
        proofs: string[],
        proofType: SupportedCredentialProofType,
        tenantId: string,
        logContext: AuditLogContext,
        credentialConfigurationId: string,
    ): Promise<void> {
        try {
            await this.validateAndConsumeCredentialNonces.execute(
                proofs,
                proofType,
                tenantId,
            );
        } catch (error) {
            if (!(error instanceof CredentialNonceValidationError)) {
                throw error;
            }
            const protocolError = new CredentialRequestException(
                error.code,
                error.message,
            );
            if (error.shouldAudit) {
                this.auditLogger.logFlowError(logContext, protocolError, {
                    credentialConfigurationId,
                });
            }
            throw protocolError;
        }
    }
}
