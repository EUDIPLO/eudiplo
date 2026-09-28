import { describe, expect, it } from "vitest";
import { DeferredTransactionStatus } from "../domain/deferred-transaction-status.js";
import { ResolveDeferredCredentialRetrieval } from "./resolve-deferred-credential-retrieval.js";

describe("ResolveDeferredCredentialRetrieval", () => {
    const useCase = new ResolveDeferredCredentialRetrieval();
    const expiresAt = new Date("2026-09-28T00:00:00.000Z");
    const now = new Date("2026-09-27T00:00:00.000Z");

    it("marks expired transactions for persistence before returning an error", () => {
        expect(
            useCase.execute({
                status: DeferredTransactionStatus.Pending,
                interval: 5,
                expiresAt: new Date("2026-09-26T00:00:00.000Z"),
                now,
            }),
        ).toEqual({ kind: "expire" });
    });

    it("preserves polling and failure details", () => {
        expect(
            useCase.execute({
                status: DeferredTransactionStatus.Pending,
                interval: 12,
                expiresAt,
                now,
            }),
        ).toEqual({ kind: "pending", interval: 12 });
        expect(
            useCase.execute({
                status: DeferredTransactionStatus.Failed,
                interval: 5,
                expiresAt,
                errorMessage: "Identity verification failed",
                now,
            }),
        ).toEqual({ kind: "failed", message: "Identity verification failed" });
    });

    it("returns ready credentials and rejects missing ready credentials", () => {
        expect(
            useCase.execute({
                status: DeferredTransactionStatus.Ready,
                interval: 5,
                expiresAt,
                credential: "credential-jwt",
                now,
            }),
        ).toEqual({ kind: "ready", credential: "credential-jwt" });
        expect(
            useCase.execute({
                status: DeferredTransactionStatus.Ready,
                interval: 5,
                expiresAt,
                now,
            }),
        ).toEqual({
            kind: "retrieved",
            message: "Credential is marked as ready but not available",
        });
    });
});
