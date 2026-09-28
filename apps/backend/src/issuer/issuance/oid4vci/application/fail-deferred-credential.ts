import type {
    DeferredTransactionData,
    DeferredTransactionRepository,
} from "../ports/deferred-transaction.repository.js";

export class FailDeferredCredential {
    constructor(
        private readonly transactions: Pick<
            DeferredTransactionRepository,
            "find" | "markFailed"
        >,
    ) {}

    async execute(
        tenantId: string,
        transactionId: string,
        errorMessage?: string,
    ): Promise<DeferredTransactionData | null> {
        const transaction = await this.transactions.find(
            tenantId,
            transactionId,
        );
        if (!transaction) return null;

        return this.transactions.markFailed(
            tenantId,
            transactionId,
            errorMessage ?? "Transaction marked as failed",
        );
    }
}
