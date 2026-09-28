import { describe, expect, it } from "vitest";
import { resolveWalletAttestationPolicy } from "./wallet-attestation-policy.js";

describe("resolveWalletAttestationPolicy", () => {
    it("uses authorization server wallet attestation settings before issuance defaults", () => {
        const issuerTrustList = [{ url: "https://issuer.example/trust.jwt" }];
        const authServerTrustList = [{ url: "https://as.example/trust.jwt" }];

        expect(
            resolveWalletAttestationPolicy(
                {
                    walletAttestationRequired: false,
                    walletProviderTrustLists: issuerTrustList,
                },
                {
                    walletAttestationRequired: true,
                    walletProviderTrustLists: authServerTrustList,
                },
            ),
        ).toEqual({
            walletAttestationRequired: true,
            walletProviderTrustLists: authServerTrustList,
        });
    });

    it("falls back to issuance-level wallet attestation settings", () => {
        const issuerTrustList = [{ url: "https://issuer.example/trust.jwt" }];

        expect(
            resolveWalletAttestationPolicy({
                walletAttestationRequired: true,
                walletProviderTrustLists: issuerTrustList,
            }),
        ).toEqual({
            walletAttestationRequired: true,
            walletProviderTrustLists: issuerTrustList,
        });
    });

    it("defaults to optional wallet attestation with no trust lists", () => {
        expect(resolveWalletAttestationPolicy({})).toEqual({
            walletAttestationRequired: false,
            walletProviderTrustLists: [],
        });
    });

    it("preserves explicit false and empty AS overrides", () => {
        expect(
            resolveWalletAttestationPolicy(
                {
                    walletAttestationRequired: true,
                    walletProviderTrustLists: [
                        { url: "https://issuer.example/trust.jwt" },
                    ],
                },
                {
                    walletAttestationRequired: false,
                    walletProviderTrustLists: [],
                },
            ),
        ).toEqual({
            walletAttestationRequired: false,
            walletProviderTrustLists: [],
        });
    });

    it("inherits trust independently of the AS requirement override", () => {
        const walletProviderTrustLists = [
            { url: "https://issuer.example/trust.jwt" },
        ];
        expect(
            resolveWalletAttestationPolicy(
                { walletAttestationRequired: true, walletProviderTrustLists },
                { walletAttestationRequired: false },
            ),
        ).toEqual({
            walletAttestationRequired: false,
            walletProviderTrustLists,
        });
    });
});
