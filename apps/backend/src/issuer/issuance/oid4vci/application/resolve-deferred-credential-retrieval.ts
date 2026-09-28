import { DeferredTransactionStatus } from "../domain/deferred-transaction-status.js";

export interface DeferredCredentialRetrievalInput {
    credential?: string | null;
    errorMessage?: string | null;
    expiresAt: Date;
    interval: number;
    status: DeferredTransactionStatus;
    now?: Date;
}

export type DeferredCredentialRetrieval =
    | { kind: "expire" }
    | { kind: "pending"; interval: number }
    | { kind: "failed"; message: string }
    | { kind: "expired"; message: string }
    | { kind: "retrieved"; message: string }
    /** Ready without a stored credential, or an unknown status. */
    | { kind: "unavailable"; message: string }
    | { kind: "ready"; credential: string };

export class ResolveDeferredCredentialRetrieval {
    execute(
        input: DeferredCredentialRetrievalInput,
    ): DeferredCredentialRetrieval {
        const now = input.now ?? new Date();
        if (now > input.expiresAt) {
            return { kind: "expire" };
        }

        switch (input.status) {
            case DeferredTransactionStatus.Pending:
                return { kind: "pending", interval: input.interval };
            case DeferredTransactionStatus.Failed:
                return {
                    kind: "failed",
                    message:
                        input.errorMessage ||
                        "The credential issuance has failed",
                };
            case DeferredTransactionStatus.Expired:
                return {
                    kind: "expired",
                    message: "The transaction has expired",
                };
            case DeferredTransactionStatus.Retrieved:
                return {
                    kind: "retrieved",
                    message: "The credential has already been retrieved",
                };
            case DeferredTransactionStatus.Ready:
                if (!input.credential) {
                    return {
                        kind: "unavailable",
                        message:
                            "Credential is marked as ready but not available",
                    };
                }
                return { kind: "ready", credential: input.credential };
            default:
                return {
                    kind: "unavailable",
                    message: "Unknown transaction status",
                };
        }
    }
}
