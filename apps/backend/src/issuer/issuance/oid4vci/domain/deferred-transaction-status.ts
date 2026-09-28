/**
 * Status of a deferred credential transaction.
 */
export enum DeferredTransactionStatus {
    /**
     * Credential issuance is pending - external system is processing.
     */
    Pending = "pending",
    /**
     * Credential is ready for retrieval.
     */
    Ready = "ready",
    /**
     * Credential has been retrieved by the wallet.
     */
    Retrieved = "retrieved",
    /**
     * Transaction has expired.
     */
    Expired = "expired",
    /**
     * Credential issuance failed.
     */
    Failed = "failed",
}
