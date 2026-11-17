import { describe, expect, it } from "vitest";
import { PresentationConfigCreateSchema } from "./presentation-config.schema.js";

const basePresentationConfig = {
    id: "age-over-16",
    description: "Age over 16",
    dcql_query: {
        credentials: [
            {
                id: "age_credential",
                format: "dc+sd-jwt",
                meta: {
                    vct_values: ["https://example.com/age"],
                },
            },
        ],
    },
};

describe("PresentationConfigCreateSchema", () => {
    it("keeps the purpose and privacy policy with the registration certificate", () => {
        const withCert = (registration_cert: unknown) =>
            PresentationConfigCreateSchema.safeParse({
                ...basePresentationConfig,
                registration_cert,
            }).success;

        expect(
            withCert({
                jwt: "a.b.c",
                purpose: [{ lang: "en", content: "Verify age eligibility" }],
                privacy_policy: "https://example.com/privacy",
            }),
        ).toBe(true);
        expect(
            withCert({
                purpose: [{ lang: "en", content: "Verify age eligibility" }],
            }),
        ).toBe(true);
        expect(withCert(null)).toBe(true);
        expect(withCert({ purpose: [{ lang: "en" }] })).toBe(false);
    });

    it("refuses the removed registrar fields", () => {
        const parse = (fields: Record<string, unknown>) =>
            PresentationConfigCreateSchema.safeParse({
                ...basePresentationConfig,
                ...fields,
            }).success;

        expect(parse({ registration_cert: { id: "cert-1" } })).toBe(false);
        expect(
            parse({
                registration_cert: {
                    body: { privacy_policy: "https://example.com/privacy" },
                },
            }),
        ).toBe(false);
        expect(parse({ registrationCertImportJwt: "a.b.c" })).toBe(false);
    });

    it("accepts allowedOrigins only in serialized origin form", () => {
        const withOrigins = (allowedOrigins: unknown) =>
            PresentationConfigCreateSchema.safeParse({
                ...basePresentationConfig,
                allowedOrigins,
            }).success;

        expect(
            withOrigins(["https://shop.example", "http://localhost:4200"]),
        ).toBe(true);
        expect(withOrigins(null)).toBe(true);
        expect(withOrigins(["https://shop.example/"])).toBe(false);
        expect(withOrigins(["https://shop.example/checkout"])).toBe(false);
        expect(withOrigins(["https://Shop.example"])).toBe(false);
        expect(withOrigins(["https://shop.example:443"])).toBe(false);
        expect(withOrigins(["shop.example"])).toBe(false);
        expect(withOrigins(["*"])).toBe(false);
        expect(withOrigins("https://shop.example")).toBe(false);
        const many = (count: number) =>
            Array.from(
                { length: count },
                (_, index) => `https://${index}.example`,
            );
        expect(withOrigins(many(100))).toBe(true);
        expect(withOrigins(many(101))).toBe(false);
    });

    describe("etsi_tl values", () => {
        const withTrustList = (value: Record<string, unknown>) =>
            PresentationConfigCreateSchema.safeParse({
                ...basePresentationConfig,
                dcql_query: {
                    credentials: [
                        {
                            ...basePresentationConfig.dcql_query.credentials[0],
                            trusted_authorities: [
                                { type: "etsi_tl", values: [value] },
                            ],
                        },
                    ],
                },
            }).success;

        it.each([
            [
                "a LoTE without format",
                { url: "https://tl.example/lote.jwt", verifierX509Der: "MIIB" },
            ],
            ["a LoTE with format", { format: "lote", trustListId: "issuers" }],
            [
                "a list of trusted lists",
                {
                    format: "trusted-list",
                    url: "https://tl.example/lotl.xml",
                    signingCertificates: ["MIIB", "MIIC=="],
                    schemeTerritories: ["DE"],
                },
            ],
            [
                "a national Trusted List",
                {
                    format: "trusted-list",
                    url: "<TENANT_URL>/tl.xml",
                    signingCertificates: ["MIIB"],
                },
            ],
        ])("accepts %s", (_, value) => {
            expect(withTrustList(value)).toBe(true);
        });

        it.each([
            [
                "a Trusted List without signing certificates",
                { format: "trusted-list", url: "https://tl.example/lotl.xml" },
            ],
            [
                "a Trusted List with an empty list of signing certificates",
                {
                    format: "trusted-list",
                    url: "https://tl.example/lotl.xml",
                    signingCertificates: [],
                },
            ],
            [
                "a Trusted List with a signing certificate that is not base64",
                {
                    format: "trusted-list",
                    url: "https://tl.example/lotl.xml",
                    signingCertificates: ["-----BEGIN CERTIFICATE-----"],
                },
            ],
            [
                "a Trusted List without URL",
                { format: "trusted-list", signingCertificates: ["MIIB"] },
            ],
            [
                "a managed Trusted List",
                {
                    format: "trusted-list",
                    trustListId: "issuers",
                    url: "https://tl.example/lotl.xml",
                    signingCertificates: ["MIIB"],
                },
            ],
            [
                "a Trusted List with a JWT verifier",
                {
                    format: "trusted-list",
                    url: "https://tl.example/lotl.xml",
                    signingCertificates: ["MIIB"],
                    verifierX509Der: "MIIB",
                },
            ],
            [
                "a LoTE with signing certificates",
                {
                    url: "https://tl.example/lote.jwt",
                    verifierX509Der: "MIIB",
                    signingCertificates: ["MIIB"],
                },
            ],
            [
                "an unknown format",
                { format: "xml", url: "https://tl.example/lotl.xml" },
            ],
        ])("rejects %s", (_, value) => {
            expect(withTrustList(value)).toBe(false);
        });
    });

    it("continues rejecting unrelated fields", () => {
        const result = PresentationConfigCreateSchema.safeParse({
            ...basePresentationConfig,
            unknownField: true,
        });

        expect(result.success).toBe(false);
    });

    it("accepts a valid TS12 payment transaction payload", () => {
        const result = PresentationConfigCreateSchema.safeParse({
            ...basePresentationConfig,
            transaction_data: [
                {
                    type: "urn:eudi:sca:payment:1",
                    credential_ids: ["age_credential"],
                    payload: {
                        transaction_id: "payment-1",
                        payee: { name: "Example Merchant", id: "merchant-1" },
                        currency: "EUR",
                        amount: 100,
                    },
                },
            ],
        });

        expect(result.success).toBe(true);
    });

    it("rejects an incomplete TS12 payment transaction payload", () => {
        const result = PresentationConfigCreateSchema.safeParse({
            ...basePresentationConfig,
            transaction_data: [
                {
                    type: "urn:eudi:sca:payment:1",
                    credential_ids: ["age_credential"],
                    payload: { transaction_id: "payment-1" },
                },
            ],
        });

        expect(result.success).toBe(false);
    });
});
