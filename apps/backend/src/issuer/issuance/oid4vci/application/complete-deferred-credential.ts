import type { Jwk } from "@openid4vc/oauth2";
import type { GetSessionForTenant } from "../../../../session/application/get-session-for-tenant.js";
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
            "findPending" | "markReady"
        >,
        private readonly sessions: Pick<GetSessionForTenant, "execute">,
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

        const session = await this.sessions.execute(
            transaction.tenantId,
            transaction.sessionId,
        );
        const credential = await this.issuer.issue(
            transaction.credentialConfigurationId,
            transaction.holderCnf as Jwk,
            session,
            input.claims,
            transaction.issuanceSetId ?? undefined,
        );

        return this.transactions.markReady(
            input.tenantId,
            input.transactionId,
            credential,
        );
    }
}
