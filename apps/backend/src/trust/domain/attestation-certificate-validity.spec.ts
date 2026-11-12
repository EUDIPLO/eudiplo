import { describe, expect, it } from "vitest";
import {
    AttestationCertificateNotValid,
    assertAttestationPathValidAt,
} from "./attestation-certificate-validity.js";

describe("assertAttestationPathValidAt", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    const valid = {
        notBefore: new Date("2026-01-01T00:00:00Z"),
        notAfter: new Date("2027-01-01T00:00:00Z"),
    };
    const expired = {
        notBefore: new Date("2025-01-01T00:00:00Z"),
        notAfter: new Date("2026-01-01T00:00:00Z"),
    };

    it("reports the first certificate outside its period, from the signing certificate up", () => {
        expect(() =>
            assertAttestationPathValidAt([valid, expired, expired], 2, now),
        ).toThrow(
            "Intermediate certificate has expired (notAfter 2026-01-01T00:00:00.000Z, checked at 2026-07-01T00:00:00.000Z)",
        );
    });

    it("checks no certificate above the listed one", () => {
        expect(() =>
            assertAttestationPathValidAt([valid, expired], 0, now),
        ).not.toThrow();
    });

    it("writes a date that is not a number as invalid", () => {
        const invalid = new Date(Number.NaN);
        let error: unknown;
        try {
            assertAttestationPathValidAt(
                [valid, { notBefore: invalid, notAfter: invalid }],
                1,
                now,
            );
        } catch (e) {
            error = e;
        }

        expect(error).toBeInstanceOf(AttestationCertificateNotValid);
        expect(error).toMatchObject({
            position: "trust list",
            validity: "not_yet_valid",
            message:
                "Trust list certificate is not yet valid (notBefore invalid, checked at 2026-07-01T00:00:00.000Z)",
        });
    });
});
