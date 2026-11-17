import { describe, expect, it, vi } from "vitest";
import { AccessCertificateStorage } from "./access-certificate-storage.service.js";

function setup(chainFor: ReturnType<typeof vi.fn>) {
    const certService = {
        addCertificate: vi.fn().mockResolvedValue("access"),
    };
    const storage = new AccessCertificateStorage(
        {} as never,
        certService as never,
        { chainFor } as never,
    );
    return { storage, certService };
}

const issued = (revoke = vi.fn().mockResolvedValue(undefined)) => ({
    registrar: "Test",
    id: "cert-1",
    value: "LEAF",
    revoke,
});

describe("AccessCertificateStorage.store", () => {
    it("stores the certificate followed by its issuing CA", async () => {
        const { storage, certService } = setup(
            vi.fn().mockResolvedValue(["LEAF", "CA"]),
        );

        await expect(
            storage.store("t", "access", issued(), "From Test"),
        ).resolves.toBe("access");
        expect(certService.addCertificate).toHaveBeenCalledWith("t", {
            crt: ["LEAF", "CA"],
            keyId: "access",
            defaultDescription: "From Test",
        });
    });

    it("revokes once and keeps the original error when the chain cannot be built", async () => {
        const failure = new Error("not a certificate");
        const { storage, certService } = setup(
            vi.fn().mockRejectedValue(failure),
        );
        const certificate = issued();

        await expect(
            storage.store("t", "access", certificate, "From Test"),
        ).rejects.toBe(failure);
        expect(certificate.revoke).toHaveBeenCalledOnce();
        expect(certService.addCertificate).not.toHaveBeenCalled();
    });

    it("revokes a certificate the key chain does not accept", async () => {
        const { storage, certService } = setup(
            vi.fn().mockResolvedValue(["LEAF"]),
        );
        certService.addCertificate.mockRejectedValue(new Error("other key"));
        const certificate = issued();

        await expect(
            storage.store("t", "access", certificate, "From Test"),
        ).rejects.toThrow("other key");
        expect(certificate.revoke).toHaveBeenCalledOnce();
    });
});
