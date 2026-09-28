import type { Jwk } from "@openid4vc/oauth2";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { DeferredTransactionStatus } from "../domain/deferred-transaction-status.js";

export const DEFERRED_TRANSACTION_REPOSITORY = Symbol(
    "DEFERRED_TRANSACTION_REPOSITORY",
);

export interface DeferredTransactionData {
    transactionId: string;
    tenantId: string;
    sessionId: string;
    credentialConfigurationId: string;
    issuanceSetId?: string | null;
    holderCnf: Record<string, unknown>;
    status: DeferredTransactionStatus;
    credential?: string | null;
    errorMessage?: string | null;
    interval: number;
    expiresAt: Date;
}

export interface DeferredTransactionRepository {
    create(transaction: DeferredTransactionData): Promise<void>;
    findPending(
        tenantId: string,
        transactionId: string,
    ): Promise<DeferredTransactionData | null>;
    find(
        tenantId: string,
        transactionId: string,
    ): Promise<DeferredTransactionData | null>;
    markReady(
        tenantId: string,
        transactionId: string,
        credential: string,
    ): Promise<DeferredTransactionData>;
    markFailed(
        tenantId: string,
        transactionId: string,
        errorMessage: string,
    ): Promise<DeferredTransactionData>;
    /**
     * Moves a ready transaction to `retrieved`. Returns false when it was not
     * ready anymore, for example because a concurrent request retrieved it.
     */
    markRetrieved(tenantId: string, transactionId: string): Promise<boolean>;
    markExpired(tenantId: string, transactionId: string): Promise<void>;
    deleteExpired(now: Date): Promise<void>;
}

export interface DeferredCredentialIssuer {
    issue(
        credentialConfigurationId: string,
        holderCnf: Jwk,
        session: SessionData,
        claims: Record<string, unknown>,
        issuanceSetId?: string,
    ): Promise<string>;
}
