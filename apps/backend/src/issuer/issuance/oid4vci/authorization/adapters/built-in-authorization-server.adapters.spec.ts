import { describe, expect, it, vi } from "vitest";
import { RevocationCheckMode } from "../../../../../trust/types.js";
import type { WalletAttestationService } from "../../../../../trust/wallet-attestation.service.js";
import { WalletAttestationClientVerifier } from "./built-in-authorization-server.adapters.js";

describe("WalletAttestationClientVerifier", () => {
    const verify = (idx: number | undefined) =>
        new WalletAttestationClientVerifier({
            verifyWalletAttestation: vi.fn(async () =>
                idx === undefined
                    ? undefined
                    : {
                          uri: "https://wp.example/wia",
                          idx,
                          certificates: ["wia-leaf"],
                      },
            ),
        } as unknown as WalletAttestationService).verify(
            "tenant-1",
            { clientAttestationJwt: "wia" },
            "https://as.example",
            false,
            [],
            RevocationCheckMode.Disabled,
        );

    it("gives the status entry of the accepted wallet attestation as the session keeps it", async () => {
        await expect(verify(2_147_483_647)).resolves.toEqual({
            statusUri: "https://wp.example/wia",
            statusIdx: 2_147_483_647,
            certificates: ["wia-leaf"],
        });
    });

    it.each([
        ["without entry", undefined],
        ["for an index that cannot be recorded", 2_147_483_648],
    ])("gives nothing %s", async (_case, idx) => {
        await expect(verify(idx)).resolves.toBeUndefined();
    });
});
