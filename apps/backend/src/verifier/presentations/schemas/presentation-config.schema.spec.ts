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
    it("accepts registration certificate fields submitted by the management UI", () => {
        const result = PresentationConfigCreateSchema.safeParse({
            ...basePresentationConfig,
            registrationCertImportJwt: "",
            registrationCertImportId: "cert-1",
            registrationCertBodyPrivacyPolicy: "https://example.com/privacy",
            registrationCertBodySupportUri: "https://example.com/support",
            registrationCertBodyIntermediary: "Example Verifier",
            registrationCertBodyPurpose: [
                {
                    lang: "en-US",
                    content: "Verify age eligibility",
                },
            ],
        });

        expect(result.success).toBe(true);
    });

    it("uses the registrar's provides_attestations for issuer registrations", () => {
        const withBody = (body: Record<string, unknown>) =>
            PresentationConfigCreateSchema.safeParse({
                ...basePresentationConfig,
                registration_cert: {
                    body: {
                        privacy_policy: "https://example.com/privacy",
                        support_uri: "https://example.com/support",
                        ...body,
                    },
                },
            }).success;

        expect(
            withBody({ provides_attestations: ["https://example.com/age"] }),
        ).toBe(true);
        expect(withBody({ provides_attestations: [{ vct: "x" }] })).toBe(false);
        expect(withBody({ provided_attestations: [{ vct: "x" }] })).toBe(false);
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
