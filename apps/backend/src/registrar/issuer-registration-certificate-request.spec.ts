import { describe, expect, it } from "vitest";
import { issuerRegistrationCertificateBody } from "./issuer-registration-certificate-request.js";

describe("issuerRegistrationCertificateBody", () => {
    const types = [
        { format: "mso_mdoc" as const, type: "eu.europa.ec.eudi.mdl.1" },
        { format: "dc+sd-jwt" as const, type: "urn:eudi:pid:1" },
    ];

    it("sends the types as custom attestations and empties provides_attestations", () => {
        expect(issuerRegistrationCertificateBody({}, types)).toEqual({
            provides_attestations: [],
            custom_provides_attestations: [
                {
                    format: "mso_mdoc",
                    meta: { doctype_value: "eu.europa.ec.eudi.mdl.1" },
                },
                {
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:eudi:pid:1"] },
                },
            ],
        });
    });

    it("adds the privacy policy and support URI only when set", () => {
        expect(
            issuerRegistrationCertificateBody(
                { privacyPolicy: "https://p", supportUri: "https://s" },
                types,
            ),
        ).toMatchObject({
            privacy_policy: "https://p",
            support_uri: "https://s",
        });
        expect(
            issuerRegistrationCertificateBody({ privacyPolicy: "" }, types),
        ).not.toHaveProperty("privacy_policy");
    });
});
