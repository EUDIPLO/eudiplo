import { decodeJwt } from "jose";
import type { CredentialNonceRepository } from "../ports/credential-nonce.repository.js";

export type CredentialNonceValidationErrorCode =
    | "invalid_proof"
    | "invalid_nonce";

export class CredentialNonceValidationError extends Error {
    constructor(
        readonly code: CredentialNonceValidationErrorCode,
        message: string,
        readonly shouldAudit: boolean,
    ) {
        super(message);
        this.name = "CredentialNonceValidationError";
    }
}

export class ValidateAndConsumeCredentialNonces {
    constructor(private readonly nonces: CredentialNonceRepository) {}

    async execute(
        proofs: string[],
        proofType: "jwt" | "attestation",
        tenantId: string,
        now = new Date(),
    ): Promise<void> {
        const uniqueNonces = new Set<string>();
        for (const proof of proofs) {
            const nonce = decodeJwt(proof).nonce;
            if (!nonce) {
                throw new CredentialNonceValidationError(
                    "invalid_proof",
                    `All ${proofType} key proofs must contain a nonce when the nonce endpoint is offered`,
                    false,
                );
            }
            uniqueNonces.add(nonce as string);
        }

        for (const nonce of uniqueNonces) {
            const stored = await this.nonces.find(tenantId, nonce);
            if (!stored) {
                throw new CredentialNonceValidationError(
                    "invalid_nonce",
                    "The nonce in the key proof is invalid or has already been used",
                    true,
                );
            }

            if (stored.expiresAt < now) {
                await this.nonces.delete(tenantId, nonce);
                throw new CredentialNonceValidationError(
                    "invalid_nonce",
                    "The nonce in the key proof has expired",
                    true,
                );
            }

            // The delete is the atomic consumption step: a concurrent request
            // that consumed the same nonce first leaves nothing to delete.
            const consumed = await this.nonces.delete(tenantId, nonce);
            if (!consumed) {
                throw new CredentialNonceValidationError(
                    "invalid_nonce",
                    "The nonce in the key proof is invalid or has already been used",
                    true,
                );
            }
        }
    }
}
