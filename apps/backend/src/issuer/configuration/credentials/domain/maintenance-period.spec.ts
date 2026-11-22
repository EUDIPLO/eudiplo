import { describe, expect, it } from "vitest";
import {
    boundCredentialExpiry,
    CredentialLifetimeExhausted,
    maintenancePeriodEnd,
} from "./maintenance-period.js";

const NOW = 1_800_000_000;

describe("maintenancePeriodEnd", () => {
    it("is the earlier end of the key and the wallet attestation", () => {
        expect(
            maintenancePeriodEnd(
                true,
                { maintainedUntil: NOW + 100 },
                { maintainedUntil: NOW + 50 },
            ),
        ).toEqual({ end: NOW + 50, attestation: "wallet" });
        expect(
            maintenancePeriodEnd(
                true,
                { maintainedUntil: NOW + 10 },
                { maintainedUntil: NOW + 50 },
            ),
        ).toEqual({ end: NOW + 10, attestation: "key" });
    });

    it("uses the one attestation that has a maintenance period", () => {
        expect(
            maintenancePeriodEnd(true, {}, { maintainedUntil: NOW + 5 }),
        ).toEqual({ end: NOW + 5, attestation: "wallet" });
        expect(maintenancePeriodEnd(true, undefined, null)).toBeUndefined();
    });

    it("bounds nothing for a configuration that does not follow the wallet unit", () => {
        expect(
            maintenancePeriodEnd(
                false,
                { maintainedUntil: NOW },
                { maintainedUntil: NOW },
            ),
        ).toBeUndefined();
    });
});

describe("boundCredentialExpiry", () => {
    const bound = { end: NOW + 86_400, attestation: "wallet" as const };

    it("ends the credential before the maintenance period", () => {
        expect(boundCredentialExpiry(NOW + 30 * 86_400, bound, NOW)).toBe(
            NOW + 86_399,
        );
    });

    it("keeps an expiry that already ends earlier", () => {
        expect(boundCredentialExpiry(NOW + 3600, bound, NOW)).toBe(NOW + 3600);
    });

    it("gives a credential without expiry the bound", () => {
        expect(boundCredentialExpiry(undefined, bound, NOW)).toBe(NOW + 86_399);
    });

    it("keeps the expiry without bound", () => {
        expect(
            boundCredentialExpiry(undefined, undefined, NOW),
        ).toBeUndefined();
        expect(boundCredentialExpiry(NOW + 5, undefined, NOW)).toBe(NOW + 5);
    });

    it.each([
        ["has ended", NOW - 10],
        ["ends now", NOW],
        ["ends in a second", NOW + 1],
    ])("refuses when the maintenance period %s", (_case, end) => {
        const error = (() => {
            try {
                boundCredentialExpiry(
                    NOW + 3600,
                    { end, attestation: "key" },
                    NOW,
                );
            } catch (e) {
                return e;
            }
        })();
        expect(error).toBeInstanceOf(CredentialLifetimeExhausted);
        expect((error as CredentialLifetimeExhausted).attestation).toBe("key");
    });
});
