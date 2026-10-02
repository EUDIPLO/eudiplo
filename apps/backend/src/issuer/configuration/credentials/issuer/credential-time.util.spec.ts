import { describe, expect, it } from "vitest";
import { certificateNotBefore } from "../../../../crypto/key/cert/certificate-builder.service.js";
import {
    clampCredentialValidityToCertificate,
    roundedCredentialValidity,
} from "./credential-time.util.js";

const at = (iso: string) => new Date(iso).getTime();
const sec = (iso: string) => at(iso) / 1000;
const DAY = 24 * 60 * 60;

describe("clampCredentialValidityToCertificate", () => {
    const certificate = {
        notBefore: new Date("2026-10-01T12:21:58Z"),
        notAfter: new Date("2027-10-01T12:21:58Z"),
    };

    it("moves the issuance time up to a certificate created within the hour", () => {
        const now = at("2026-10-01T12:30:00Z");
        const result = clampCredentialValidityToCertificate(
            roundedCredentialValidity(DAY, now),
            certificate,
            now,
        );
        expect(result.issuedAt).toBe(sec("2026-10-01T12:21:58Z"));
        expect(result.expiresAt).toBe(sec("2026-10-02T13:00:00Z"));
    });

    it("keeps the rounded validity when it lies within the certificate", () => {
        const now = at("2026-10-01T14:30:00Z");
        const rounded = roundedCredentialValidity(DAY, now);
        expect(
            clampCredentialValidityToCertificate(rounded, certificate, now),
        ).toEqual(rounded);
    });

    it("caps the expiry at the certificate expiry", () => {
        const now = at("2027-09-30T12:00:00Z");
        const result = clampCredentialValidityToCertificate(
            roundedCredentialValidity(365 * DAY, now),
            certificate,
            now,
        );
        expect(result.expiresAt).toBe(sec("2027-10-01T12:21:58Z"));
    });

    it("throws when the certificate is not yet valid", () => {
        const now = at("2026-10-01T12:00:00Z");
        expect(() =>
            clampCredentialValidityToCertificate(
                roundedCredentialValidity(DAY, now),
                certificate,
                now,
            ),
        ).toThrow(/not valid at issuance time/);
    });

    it("throws when the certificate has expired", () => {
        const now = at("2027-10-01T13:00:00Z");
        expect(() =>
            clampCredentialValidityToCertificate(
                roundedCredentialValidity(DAY, now),
                certificate,
                now,
            ),
        ).toThrow(/not valid at issuance time/);
    });

    it("never clamps for certificates generated with an hour-aligned notBefore", () => {
        const created = new Date("2026-10-01T12:21:58Z");
        const generated = {
            notBefore: certificateNotBefore(created),
            notAfter: new Date("2027-10-01T12:21:58Z"),
        };
        const now = at("2026-10-01T12:30:00Z");
        const rounded = roundedCredentialValidity(DAY, now);
        expect(
            clampCredentialValidityToCertificate(rounded, generated, now),
        ).toEqual(rounded);
    });
});
