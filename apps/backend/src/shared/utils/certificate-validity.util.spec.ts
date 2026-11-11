import { describe, expect, it } from "vitest";
import { certificateValidityAt } from "./certificate-validity.util.js";

describe("certificateValidityAt", () => {
    const period = {
        notBefore: new Date("2026-01-01T00:00:00Z"),
        notAfter: new Date("2026-12-31T23:59:59Z"),
    };

    it.each([
        ["2025-12-31T23:59:59Z", "not_yet_valid"],
        ["2026-01-01T00:00:00Z", "valid"],
        ["2026-06-01T12:00:00Z", "valid"],
        ["2026-12-31T23:59:59Z", "valid"],
        ["2027-01-01T00:00:00Z", "expired"],
    ])("at %s is %s, both ends included", (now, expected) => {
        expect(certificateValidityAt(period, new Date(now))).toBe(expected);
    });

    it("puts a date that is not a number outside the period", () => {
        const invalid = new Date(Number.NaN);

        expect(
            certificateValidityAt(
                { ...period, notBefore: invalid },
                new Date(),
            ),
        ).toBe("not_yet_valid");
        expect(
            certificateValidityAt({ ...period, notAfter: invalid }, new Date()),
        ).toBe("expired");
        expect(certificateValidityAt(period, invalid)).toBe("not_yet_valid");
    });
});
