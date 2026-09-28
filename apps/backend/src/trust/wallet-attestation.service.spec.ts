import { describe, expect, it, vi } from "vitest";
import { WalletAttestationService } from "./wallet-attestation.service.js";

describe("WalletAttestationService trust requirements", () => {
    function createService() {
        return Object.assign(
            Object.create(WalletAttestationService.prototype),
            {
                getIssuer: () => ({ verifyWalletAttestation: vi.fn() }),
                settings: { cryptoToleranceSeconds: 0 },
            },
        ) as WalletAttestationService;
    }

    it("allows an absent optional attestation", async () => {
        await expect(
            createService().verifyWalletAttestation(
                "tenant",
                undefined,
                "https://as.example",
                false,
                [],
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects an absent required attestation", async () => {
        await expect(
            createService().verifyWalletAttestation(
                "tenant",
                undefined,
                "https://as.example",
                true,
                [],
            ),
        ).rejects.toThrow("required but not provided");
    });

    it.each([true, false])(
        "requires provider trust for a presented attestation (required=%s)",
        async (required) => {
            await expect(
                createService().verifyWalletAttestation(
                    "tenant",
                    {
                        clientAttestationJwt: "signed-attestation",
                        clientAttestationPopJwt: "signed-pop",
                    },
                    "https://as.example",
                    required,
                    [],
                ),
            ).rejects.toThrow("No wallet provider trust lists configured");
        },
    );
});
