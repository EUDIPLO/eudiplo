import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../../session/domain/session-data.js";
import { DeferredTransactionStatus } from "../domain/deferred-transaction-status.js";
import type {
    DeferredCredentialIssuer,
    DeferredTransactionData,
    DeferredTransactionRepository,
} from "../ports/deferred-transaction.repository.js";
import { CompleteDeferredCredential } from "./complete-deferred-credential.js";
import { FailDeferredCredential } from "./fail-deferred-credential.js";

const transaction: DeferredTransactionData = {
    transactionId: "transaction-1",
    tenantId: "tenant-1",
    sessionId: "session-1",
    credentialConfigurationId: "credential-1",
    holderCnf: { kty: "EC", crv: "P-256" },
    status: DeferredTransactionStatus.Pending,
    interval: 5,
    expiresAt: new Date("2026-09-28T00:00:00.000Z"),
};

describe("deferred credential lifecycle", () => {
    it("issues and marks a pending transaction ready", async () => {
        const markReady = vi.fn(async () => ({
            ...transaction,
            status: DeferredTransactionStatus.Ready,
            credential: "credential-jwt",
        }));
        const repository: Pick<
            DeferredTransactionRepository,
            "findPending" | "markReady"
        > = {
            findPending: vi.fn(async () => transaction),
            markReady,
        };
        const session = {
            id: "session-1",
            tenantId: "tenant-1",
        } as SessionData;
        const issuer: DeferredCredentialIssuer = {
            issue: vi.fn(async () => "credential-jwt"),
        };
        const sessions = { execute: vi.fn(async () => session) };

        const result = await new CompleteDeferredCredential(
            repository,
            sessions,
            issuer,
        ).execute({
            tenantId: "tenant-1",
            transactionId: "transaction-1",
            claims: { given_name: "Ada" },
        });

        expect(result?.status).toBe(DeferredTransactionStatus.Ready);
        expect(issuer.issue).toHaveBeenCalledWith(
            "credential-1",
            transaction.holderCnf,
            session,
            { given_name: "Ada" },
            undefined,
        );
        expect(markReady).toHaveBeenCalledWith(
            "tenant-1",
            "transaction-1",
            "credential-jwt",
        );
    });

    it("does not issue when the transaction is not pending", async () => {
        const issuer: DeferredCredentialIssuer = {
            issue: vi.fn(async () => "credential-jwt"),
        };
        const repository: Pick<
            DeferredTransactionRepository,
            "findPending" | "markReady"
        > = {
            findPending: vi.fn(async () => null),
            markReady: vi.fn(),
        };
        const result = await new CompleteDeferredCredential(
            repository,
            { execute: vi.fn() },
            issuer,
        ).execute({
            tenantId: "tenant-1",
            transactionId: "missing",
            claims: {},
        });

        expect(result).toBeNull();
        expect(issuer.issue).not.toHaveBeenCalled();
    });

    it("uses the existing failure message or the default", async () => {
        const markFailed = vi.fn(async () => ({
            ...transaction,
            status: DeferredTransactionStatus.Failed,
            errorMessage: "Identity verification failed",
        }));
        const repository: Pick<
            DeferredTransactionRepository,
            "find" | "markFailed"
        > = {
            find: vi.fn(async () => transaction),
            markFailed,
        };

        await new FailDeferredCredential(repository).execute(
            "tenant-1",
            "transaction-1",
            "Identity verification failed",
        );
        expect(markFailed).toHaveBeenCalledWith(
            "tenant-1",
            "transaction-1",
            "Identity verification failed",
        );

        await new FailDeferredCredential(repository).execute(
            "tenant-1",
            "transaction-1",
        );
        expect(markFailed).toHaveBeenLastCalledWith(
            "tenant-1",
            "transaction-1",
            "Transaction marked as failed",
        );
    });
});
