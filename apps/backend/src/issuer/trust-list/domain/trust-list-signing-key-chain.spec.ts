import { describe, expect, it } from "vitest";
import { KeyUsageType } from "../../../crypto/key/types/key-usage-type.js";
import {
    trustListKeyChainUsageRefusal,
    trustListSigningKeyChain,
} from "./trust-list-signing-key-chain.js";

describe("trustListSigningKeyChain", () => {
    it("signs with the key chain in keyChainId", () => {
        expect(trustListSigningKeyChain("named", "stored")).toEqual({
            id: "named",
            kept: false,
        });
    });

    it("counts a keyChainId equal to the stored one as named", () => {
        expect(trustListSigningKeyChain("stored", "stored")).toEqual({
            id: "stored",
            kept: false,
        });
    });

    it("keeps the key chain of the stored list without keyChainId", () => {
        expect(trustListSigningKeyChain(undefined, "stored")).toEqual({
            id: "stored",
            kept: true,
        });
    });

    it("names none for a new list without keyChainId", () => {
        expect(trustListSigningKeyChain(undefined, undefined)).toBeUndefined();
    });
});

describe("trustListKeyChainUsageRefusal", () => {
    it("accepts a trustList key chain, named or kept", () => {
        for (const kept of [false, true]) {
            expect(
                trustListKeyChainUsageRefusal(
                    { id: "chain", kept },
                    KeyUsageType.TrustList,
                ),
            ).toBeUndefined();
        }
    });

    it("refuses a named key chain of another usage type", () => {
        expect(
            trustListKeyChainUsageRefusal(
                { id: "chain", kept: false },
                KeyUsageType.Attestation,
            ),
        ).toBe(
            "Key chain chain is not valid for Trust List usage (key lacks TrustList usage)",
        );
    });

    it("refuses a kept key chain of another usage type and says to name one", () => {
        expect(
            trustListKeyChainUsageRefusal(
                { id: "chain", kept: true },
                KeyUsageType.Attestation,
            ),
        ).toBe(
            "Key chain chain of this trust list is not valid for Trust List usage (key lacks TrustList usage). Name a key chain with usage type trustList in keyChainId.",
        );
    });

    it("refuses an unknown usage type", () => {
        expect(
            trustListKeyChainUsageRefusal(
                { id: "chain", kept: false },
                undefined,
            ),
        ).toBeDefined();
    });
});
