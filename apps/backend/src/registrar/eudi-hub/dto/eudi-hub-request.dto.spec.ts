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
            "a purpose language that is no language tag",
            {
                purpose: [
                    { lang: "en", content: "a" },
                    { lang: "de", content: "c" },
                    { lang: "Portuguese", content: "d" },
                ],
            },
        ],
        [
            "a service description language that is not ISO 639-1",
            {
                serviceDescription: [
                    { lang: "en", content: "Service" },
                    { lang: "de", content: "Dienst" },
                    { lang: "pt-BR", content: "Serviço" },
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

    it("accepts purposes in regional languages, which are stored but not sent", () => {
        expect(
            EudiHubPresentationRegistrationCertificateRequestSchema.safeParse({
                ...presentation,
                purpose: [
                    ...presentation.purpose,
                    { lang: "pt-BR", content: "Verificação de idade" },
                ],
            }).success,
        ).toBe(true);
    });

    it("accepts up to 50 purpose texts, also with three-letter codes, and refuses more", () => {
        const codes = Array.from(
            { length: 26 * 26 },
            (_, index) =>
                `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
        ).filter((code) => code !== "de" && code !== "en");
        const purpose = (count: number) => [
            { lang: "de", content: "Altersprüfung" },
            { lang: "en", content: "Age check" },
            ...codes
                .slice(0, count - 2)
                .map((lang) => ({ lang, content: `text ${lang}` })),
        ];
        const parse = (value: unknown) =>
            EudiHubPresentationRegistrationCertificateRequestSchema.safeParse({
                ...presentation,
                purpose: value,
            }).success;

        expect(parse(purpose(50))).toBe(true);
        expect(parse(purpose(51))).toBe(false);
        expect(
            parse([...purpose(2), { lang: "eng", content: "Age check" }]),
        ).toBe(true);
    });

    it("accepts a service description of up to 24 texts and refuses more", () => {
        const codes = Array.from(
            { length: 26 * 26 },
            (_, index) =>
                `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
        ).filter((code) => code !== "de" && code !== "en");
        const description = (count: number) => [
            { lang: "de", content: "Dienst" },
            { lang: "en", content: "Service" },
            ...codes
                .slice(0, count - 2)
                .map((lang) => ({ lang, content: `text ${lang}` })),
        ];
        const parse = (serviceDescription: unknown) =>
            EudiHubIssuerRegistrationCertificateRequestSchema.safeParse({
                ...issuer,
                serviceDescription,
            }).success;

        expect(parse(description(24))).toBe(true);
        expect(parse(description(25))).toBe(false);
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
