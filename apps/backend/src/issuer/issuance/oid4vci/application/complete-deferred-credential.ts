import type { Jwk } from "@owf/jose";
import type { SessionStore } from "../../../../session/application/session-store.js";
import { CredentialLifetimeExhausted } from "../../../configuration/credentials/domain/maintenance-period.js";
import type {
    DeferredCredentialIssuer,
    DeferredTransactionData,
    DeferredTransactionRepository,
} from "../ports/deferred-transaction.repository.js";

export interface CompleteDeferredCredentialInput {
    tenantId: string;
    transactionId: string;
    claims: Record<string, unknown>;
}

export class CompleteDeferredCredential {
    constructor(
        private readonly transactions: Pick<
            DeferredTransactionRepository,
            "findPending" | "markReady" | "markFailed"
        >,
        private readonly sessions: Pick<SessionStore, "getForTenant">,
        private readonly issuer: DeferredCredentialIssuer,
    ) {}

    async execute(
        input: CompleteDeferredCredentialInput,
    ): Promise<DeferredTransactionData | null> {
        const transaction = await this.transactions.findPending(
            input.tenantId,
            input.transactionId,
        );
        if (!transaction) return null;

        const session = await this.sessions.getForTenant(
            transaction.tenantId,
            transaction.sessionId,
        );
        let credential: string;
        try {
            credential = await this.issuer.issue(
                transaction.credentialConfigurationId,
                transaction.holderCnf as Jwk,
                session,
                input.claims,
                transaction.issuanceSetId ?? undefined,
                transaction.walletUnit ?? undefined,
            );
        } catch (error) {
            // The status maintenance period of the attestations ended while
            // the transaction was pending: the credential can no longer be
            // issued, so the wallet is told (OID4VCI 1.0 Section 9.3).
            if (error instanceof CredentialLifetimeExhausted) {
                return this.transactions.markFailed(
                    input.tenantId,
                    input.transactionId,
                    error.message,
                );
            }
            throw error;
        }

        return this.transactions.markReady(
            input.tenantId,
            input.transactionId,
            credential,
        );
    }
}
