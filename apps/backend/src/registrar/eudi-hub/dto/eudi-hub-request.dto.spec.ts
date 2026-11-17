import { describe, expect, it } from "vitest";
import {
    EudiHubAccessCertificateRequestSchema,
    EudiHubIssuerRegistrationCertificateRequestSchema,
    EudiHubOrganizationsRequestSchema,
    EudiHubPresentationRegistrationCertificateRequestSchema,
} from "./eudi-hub-request.dto.js";

describe("EUDI Hub token", () => {
    const parse = (token: string) =>
        EudiHubOrganizationsRequestSchema.safeParse({ token });

    it("takes the token with or without the Bearer prefix", () => {
        expect(parse("Bearer abc.def-_~+/=").data?.token).toBe("abc.def-_~+/=");
        expect(parse("  bearer abc.def \n").data?.token).toBe("abc.def");
        expect(parse("abc.def").data?.token).toBe("abc.def");
    });

    it.each([
        ["a line break inside", "abc\r\nX-Evil: 1"],
        ["a space inside", "abc def"],
        ["the header name", "Authorization: Bearer abc"],
        ["nothing", "   "],
        ["more than 16 KiB", "a".repeat(16_385)],
    ])("refuses %s", (_, token) => {
        expect(parse(token).success).toBe(false);
    });

    it("refuses unknown properties", () => {
        expect(
            EudiHubOrganizationsRequestSchema.safeParse({
                token: "abc",
                extra: 1,
            }).success,
        ).toBe(false);
    });
});

describe("EUDI Hub access certificate request", () => {
    const request = {
        token: "abc",
        organizationId: "01932c5a-9abc-7000-8000-000000000010",
        keyId: "access",
        environment: "sandbox",
        supportUri: "https://support.example",
    };

    it("accepts a complete request", () => {
        expect(
            EudiHubAccessCertificateRequestSchema.safeParse(request).success,
        ).toBe(true);
    });

    it.each([
        ["an organization ID that is not a UUID", { organizationId: "org-1" }],
        [
            "a support URI that is not http(s)",
            { supportUri: "ftp://x.example" },
        ],
        ["an unknown environment", { environment: "staging" }],
        ["a blank name", { name: "  " }],
        ["an unknown property", { extra: true }],
    ])("refuses %s", (_, change) => {
        expect(
            EudiHubAccessCertificateRequestSchema.safeParse({
                ...request,
                ...change,
            }).success,
        ).toBe(false);
    });
});

describe("EUDI Hub registration certificate requests", () => {
    const issuer = {
        token: "abc",
        organizationId: "01932c5a-9abc-7000-8000-000000000010",
        environment: "live",
        identifier: {
            type: "http://data.europa.eu/eudi/id/EUID",
            value: "DE/HRB1",
        },
        serviceDescription: [
            { lang: "de", content: "Dienst" },
            { lang: "en", content: "Service" },
        ],
        supportUri: "https://support.example",
        infoUri: "https://info.example",
    };
    const presentation = {
        ...issuer,
        presentationConfigId: "age",
        purpose: [
            { lang: "en", content: "Age check" },
            { lang: "de", content: "Altersprüfung" },
            { lang: "fr", content: "Contrôle de l'âge" },
        ],
        privacyPolicy: "https://verifier.example/privacy",
    };

    it("accepts complete requests", () => {
        expect(
            EudiHubPresentationRegistrationCertificateRequestSchema.safeParse(
                presentation,
            ).success,
        ).toBe(true);
        expect(
            EudiHubIssuerRegistrationCertificateRequestSchema.safeParse(issuer)
                .success,
        ).toBe(true);
    });

    it.each([
        [
            "a purpose without German",
            {
                purpose: [
                    { lang: "en", content: "Age check" },
                    { lang: "fr", content: "x" },
                ],
            },
        ],
        [
            "a language given twice",
            {
                purpose: [
                    { lang: "en", content: "a" },
                    { lang: "en", content: "b" },
                    { lang: "de", content: "c" },
                ],
            },
        ],
        [
            "a language code that is not ISO 639-1",
            {
                purpose: [
                    { lang: "eng", content: "a" },
                    { lang: "de", content: "c" },
                ],
            },
        ],
        [
            "an unknown identifier type",
            { identifier: { type: "urn:x", value: "1" } },
        ],
        ["an info URI that is not http(s)", { infoUri: "mailto:a@b.example" }],
    ])("refuses a verifier request with %s", (_, change) => {
        expect(
            EudiHubPresentationRegistrationCertificateRequestSchema.safeParse({
                ...presentation,
                ...change,
            }).success,
        ).toBe(false);
    });

    it("refuses verifier fields in an issuer request", () => {
        expect(
            EudiHubIssuerRegistrationCertificateRequestSchema.safeParse({
                ...issuer,
                purpose: presentation.purpose,
            }).success,
        ).toBe(false);
    });
});
