import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLoggerService } from "../../../session/logging/session-logger.service.js";
import { ValidateAndConsumeCredentialNonces } from "./application/validate-and-consume-credential-nonces.js";
import { NonceService } from "./nonce.service.js";
import type { CredentialNonceRepository } from "./ports/credential-nonce.repository.js";

const proof = (payload: Record<string, unknown>): string => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${encoded}.signature`;
};

describe("NonceService", () => {
    const repository = {
        save: vi.fn(),
        delete: vi.fn(),
        find: vi.fn(),
    };
    const auditLogger = { logFlowError: vi.fn() };
    const logContext = {
        sessionId: "session-id",
        tenantId: "tenant-id",
        flowType: "OID4VCI" as const,
    };

    let service: NonceService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new NonceService(
            repository as unknown as CredentialNonceRepository,
            new ValidateAndConsumeCredentialNonces(
                repository as unknown as CredentialNonceRepository,
            ),
            auditLogger as unknown as SessionLoggerService,
        );
    });

    it("issues and persists a tenant-scoped nonce", async () => {
        repository.save.mockResolvedValue(undefined);

        const nonce = await service.issue("tenant-id");

        expect(nonce).toEqual(expect.any(String));
        expect(repository.save).toHaveBeenCalledWith({
            nonce,
            tenantId: "tenant-id",
            expiresAt: expect.any(Date),
        });
    });

    it("rejects proofs without a nonce", async () => {
        await expect(
            service.validateAndConsume(
                [proof({ sub: "holder" })],
                "jwt",
                "tenant-id",
                logContext,
                "credential-id",
            ),
        ).rejects.toMatchObject({
            response: { error: "invalid_proof" },
        });
    });

    it("rejects and logs an unknown nonce", async () => {
        repository.find.mockResolvedValue(null);

        await expect(
            service.validateAndConsume(
                [proof({ nonce: "unknown" })],
                "jwt",
                "tenant-id",
                logContext,
                "credential-id",
            ),
        ).rejects.toMatchObject({
            response: { error: "invalid_nonce" },
        });
        expect(auditLogger.logFlowError).toHaveBeenCalledOnce();
    });

    it("consumes duplicate proof nonces only once", async () => {
        repository.find.mockResolvedValue({
            nonce: "valid",
            tenantId: "tenant-id",
            expiresAt: new Date(Date.now() + 60_000),
        });
        repository.delete.mockResolvedValue(true);

        await service.validateAndConsume(
            [proof({ nonce: "valid" }), proof({ nonce: "valid" })],
            "attestation",
            "tenant-id",
            logContext,
            "credential-id",
        );

        expect(repository.find).toHaveBeenCalledOnce();
        expect(repository.delete).toHaveBeenCalledOnce();
    });
});
