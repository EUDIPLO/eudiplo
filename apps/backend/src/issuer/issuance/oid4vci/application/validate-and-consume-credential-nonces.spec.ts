import { describe, expect, it, vi } from "vitest";
import {
    CredentialNonceValidationError,
    ValidateAndConsumeCredentialNonces,
} from "./validate-and-consume-credential-nonces.js";

const proof = (payload: Record<string, unknown>): string => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${encoded}.signature`;
};

describe("ValidateAndConsumeCredentialNonces", () => {
    it("requires a nonce on every proof without contacting persistence", async () => {
        const find = vi.fn();
        const useCase = new ValidateAndConsumeCredentialNonces({
            find,
        } as never);

        await expect(
            useCase.execute([proof({ sub: "holder" })], "jwt", "tenant-1"),
        ).rejects.toMatchObject({
            code: "invalid_proof",
            shouldAudit: false,
        });
        expect(find).not.toHaveBeenCalled();
    });

    it("consumes each distinct tenant nonce once", async () => {
        const find = vi.fn().mockResolvedValue({
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        });
        const remove = vi.fn().mockResolvedValue(true);
        const useCase = new ValidateAndConsumeCredentialNonces({
            find,
            delete: remove,
        } as never);

        await useCase.execute(
            [proof({ nonce: "n1" }), proof({ nonce: "n1" })],
            "attestation",
            "tenant-1",
            new Date("2029-01-01T00:00:00.000Z"),
        );
        expect(find).toHaveBeenCalledExactlyOnceWith("tenant-1", "n1");
        expect(remove).toHaveBeenCalledExactlyOnceWith("tenant-1", "n1");
    });

    it("deletes expired nonces before returning an auditable protocol error", async () => {
        const remove = vi.fn().mockResolvedValue(true);
        const useCase = new ValidateAndConsumeCredentialNonces({
            find: vi.fn().mockResolvedValue({
                expiresAt: new Date("2020-01-01T00:00:00.000Z"),
            }),
            delete: remove,
        } as never);

        await expect(
            useCase.execute(
                [proof({ nonce: "expired" })],
                "jwt",
                "tenant-1",
                new Date("2021-01-01T00:00:00.000Z"),
            ),
        ).rejects.toMatchObject({
            code: "invalid_nonce",
            shouldAudit: true,
            message: "The nonce in the key proof has expired",
        });
        expect(remove).toHaveBeenCalledExactlyOnceWith("tenant-1", "expired");
    });

    it("maps unknown nonces to the auditable invalid_nonce error", async () => {
        const useCase = new ValidateAndConsumeCredentialNonces({
            find: vi.fn().mockResolvedValue(null),
        } as never);

        await expect(
            useCase.execute([proof({ nonce: "missing" })], "jwt", "tenant-1"),
        ).rejects.toBeInstanceOf(CredentialNonceValidationError);
        await expect(
            useCase.execute([proof({ nonce: "missing" })], "jwt", "tenant-1"),
        ).rejects.toMatchObject({ code: "invalid_nonce", shouldAudit: true });
    });
});
