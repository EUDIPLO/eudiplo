import { describe, expect, it } from "vitest";
import { KeyUsageType } from "../../../crypto/key/types/key-usage-type.js";
import {
    entityKeyChainReferences,
    entityKeyChainUsageRefusal,
    storedEntityKeyChains,
} from "./trust-list-entity-key-chains.js";

const internal = (
    issuerKeyChainId: unknown,
    revocationKeyChainId: unknown,
) => ({
    type: "internal",
    issuerKeyChainId,
    revocationKeyChainId,
    info: {
        name: "Issuer",
        contactUri: "info@example.com",
        website: "https://example.com/",
    },
});

describe("entityKeyChainReferences", () => {
    it("lists the key chains of internal entities with their index and field", () => {
        expect(
            entityKeyChainReferences([
                { type: "external", issuerCertPem: "pem" },
                internal("issuer", "status"),
            ]),
        ).toEqual([
            { index: 1, field: "issuerKeyChainId", keyChainId: "issuer" },
            { index: 1, field: "revocationKeyChainId", keyChainId: "status" },
        ]);
    });

    it("leaves values that are no non-empty string to schema validation", () => {
        expect(
            entityKeyChainReferences([internal("", 42), null, "internal"]),
        ).toEqual([]);
        expect(entityKeyChainReferences(undefined)).toEqual([]);
        expect(entityKeyChainReferences({ entities: [] })).toEqual([]);
    });
});

describe("entityKeyChainUsageRefusal", () => {
    it("accepts only attestation key chains as issuer", () => {
        expect(
            entityKeyChainUsageRefusal(
                "issuerKeyChainId",
                "issuer",
                KeyUsageType.Attestation,
            ),
        ).toBeUndefined();
        expect(
            entityKeyChainUsageRefusal(
                "issuerKeyChainId",
                "status",
                KeyUsageType.StatusList,
            ),
        ).toBe(
            'Key chain "status" has usage type "statusList"; issuerKeyChainId needs a key chain with usage type "attestation".',
        );
    });

    it("accepts status list and attestation key chains for revocation", () => {
        // Status lists fall back to, or are pinned to, attestation key chains.
        for (const usageType of [
            KeyUsageType.StatusList,
            KeyUsageType.Attestation,
        ]) {
            expect(
                entityKeyChainUsageRefusal(
                    "revocationKeyChainId",
                    "key",
                    usageType,
                ),
            ).toBeUndefined();
        }
        expect(
            entityKeyChainUsageRefusal(
                "revocationKeyChainId",
                "signer",
                KeyUsageType.TrustList,
            ),
        ).toBe(
            'Key chain "signer" has usage type "trustList"; revocationKeyChainId needs a key chain with usage type "statusList" or "attestation".',
        );
    });

    it("refuses an unknown usage type", () => {
        expect(
            entityKeyChainUsageRefusal("issuerKeyChainId", "key", undefined),
        ).toContain("has usage type undefined");
    });
});

describe("storedEntityKeyChains", () => {
    const isStored = storedEntityKeyChains([
        { type: "external", issuerKeyChainId: "external" },
        internal("status", "access"),
        internal("other", "access"),
    ]);

    it("finds a key chain the stored list names in the same field", () => {
        expect(
            isStored({ field: "issuerKeyChainId", keyChainId: "status" }),
        ).toBe(true);
        expect(
            isStored({ field: "revocationKeyChainId", keyChainId: "access" }),
        ).toBe(true);
    });

    it("does not carry a stored value over to the other field", () => {
        expect(
            isStored({ field: "revocationKeyChainId", keyChainId: "status" }),
        ).toBe(false);
    });

    it("ignores external entities", () => {
        expect(
            isStored({ field: "issuerKeyChainId", keyChainId: "external" }),
        ).toBe(false);
    });

    it("finds nothing without a stored list", () => {
        expect(
            storedEntityKeyChains(undefined)({
                field: "issuerKeyChainId",
                keyChainId: "status",
            }),
        ).toBe(false);
    });
});
