import { describe, expect, it } from "vitest";
import { normalizeRegistrationCertFormFields } from "./registration-cert-form-fields.js";

describe("normalizeRegistrationCertFormFields", () => {
    it("prefers an imported JWT, then an imported id", () => {
        expect(
            normalizeRegistrationCertFormFields({
                registrationCertImportJwt: " jwt ",
                registrationCertImportId: "id",
            }),
        ).toEqual({ registration_cert: { jwt: "jwt" } });
        expect(
            normalizeRegistrationCertFormFields({
                registrationCertImportId: " id ",
                registrationCertBodySupportUri: "https://support",
            }),
        ).toEqual({ registration_cert: { id: "id" } });
    });

    it("builds a body from trimmed fields and complete purpose entries", () => {
        expect(
            normalizeRegistrationCertFormFields({
                id: "config",
                registrationCertBodyPrivacyPolicy: " https://privacy ",
                registrationCertBodySupportUri: "",
                registrationCertBodyIntermediary: null,
                registrationCertBodyPurpose: [
                    { lang: "en", content: " Age check " },
                    { lang: "de", content: "" },
                ],
            }),
        ).toEqual({
            id: "config",
            registration_cert: {
                body: {
                    privacy_policy: "https://privacy",
                    purpose: [{ lang: "en", content: "Age check" }],
                },
            },
        });
    });

    it("keeps an explicit registration_cert, including null", () => {
        expect(
            normalizeRegistrationCertFormFields({
                registration_cert: null,
                registrationCertImportJwt: "jwt",
            }),
        ).toEqual({ registration_cert: null });
    });

    it("strips form fields without adding registration_cert when all are empty", () => {
        const request = { id: "config", registrationCertImportJwt: "  " };
        expect(normalizeRegistrationCertFormFields(request)).toEqual({
            id: "config",
        });
        expect(request).toEqual({
            id: "config",
            registrationCertImportJwt: "  ",
        });
    });
});
