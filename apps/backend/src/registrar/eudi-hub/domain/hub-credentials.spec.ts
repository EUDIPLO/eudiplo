import { describe, expect, it } from "vitest";
import {
    hubCredentialsForDcql,
    sameCredentialRequest,
} from "./hub-credentials.js";

const pid = {
    id: "pid",
    format: "dc+sd-jwt",
    meta: { vct_values: ["urn:eudi:pid:de:1"] },
    claims: [{ path: ["given_name"] }, { id: "fn", path: ["family_name"] }],
};
const mdl = {
    id: "mdl",
    format: "mso_mdoc",
    meta: { doctype_value: "org.iso.18013.5.1.mDL" },
    claims: [{ path: ["org.iso.18013.5.1", "age_over_18"], values: [true] }],
};

describe("hubCredentialsForDcql", () => {
    it("names each credential query's vct or docType and claim paths", () => {
        expect(hubCredentialsForDcql({ credentials: [pid, mdl] })).toEqual({
            credentials: [
                {
                    format: "dc+sd-jwt",
                    type: "urn:eudi:pid:de:1",
                    claims: [
                        { path: ["given_name"] },
                        { path: ["family_name"] },
                    ],
                },
                {
                    format: "mso_mdoc",
                    type: "org.iso.18013.5.1.mDL",
                    claims: [{ path: ["org.iso.18013.5.1", "age_over_18"] }],
                },
            ],
        });
    });

    it.each([
        ["no credential queries", { credentials: [] }, /no credential queries/],
        [
            "several vct values",
            {
                credentials: [
                    { ...pid, meta: { vct_values: ["urn:a", "urn:b"] } },
                ],
            },
            /one vct per credential/,
        ],
        [
            "more meta than the vct",
            {
                credentials: [
                    {
                        ...pid,
                        meta: { vct_values: ["urn:a"], extra: true },
                    },
                ],
            },
            /one vct per credential/,
        ],
        [
            "an mdoc query without doctype_value",
            { credentials: [{ ...mdl, meta: {} }] },
            /doctype_value/,
        ],
        [
            "more meta than the doctype_value",
            {
                credentials: [
                    { ...mdl, meta: { doctype_value: "x", extra: 1 } },
                ],
            },
            /doctype_value/,
        ],
        [
            "a claim that is no object",
            { credentials: [{ ...pid, claims: [null] }] },
            /array indexes or wildcards/,
        ],
        [
            "an empty claim path",
            { credentials: [{ ...pid, claims: [{ path: [] }] }] },
            /array indexes or wildcards/,
        ],
        [
            "another format",
            { credentials: [{ ...pid, format: "jwt_vc_json" }] },
            /dc\+sd-jwt and mso_mdoc only/,
        ],
        [
            "no claims",
            { credentials: [{ ...pid, claims: undefined }] },
            /needs the requested claims/,
        ],
        [
            "an array index in a claim path",
            {
                credentials: [
                    { ...pid, claims: [{ path: ["nationalities", null] }] },
                ],
            },
            /array indexes or wildcards/,
        ],
    ])("refuses a DCQL query with %s", (_, dcql, problem) => {
        expect(hubCredentialsForDcql(dcql).problem).toMatch(problem);
    });

    it("names the credential query it refuses", () => {
        expect(
            hubCredentialsForDcql({
                credentials: [pid, { ...mdl, meta: {} }],
            }).problem,
        ).toContain('Credential query "mdl"');
    });
});

describe("sameCredentialRequest", () => {
    const wanted = {
        credentials: hubCredentialsForDcql({ credentials: [pid, mdl] })
            .credentials!,
        purpose: [
            { lang: "en", content: "Age check" },
            { lang: "de", content: "Altersprüfung" },
        ],
        privacyPolicy: "https://verifier.example/privacy",
    };

    it("ignores the order of credentials, claims and languages", () => {
        expect(
            sameCredentialRequest(
                {
                    credentials: [
                        wanted.credentials[1],
                        {
                            ...wanted.credentials[0],
                            claims: [
                                ...wanted.credentials[0].claims!,
                            ].reverse(),
                        },
                    ],
                    purpose: [...wanted.purpose].reverse(),
                    privacyPolicy: wanted.privacyPolicy,
                },
                wanted,
            ),
        ).toBe(true);
    });

    it.each([
        ["another privacy policy", { privacyPolicy: "https://other.example" }],
        [
            "another purpose",
            {
                purpose: [
                    { lang: "en", content: "Age check" },
                    { lang: "de", content: "Anders" },
                ],
            },
        ],
        ["fewer credentials", { credentials: [wanted.credentials[0]] }],
        [
            "another claim",
            {
                credentials: [
                    { ...wanted.credentials[0], claims: [{ path: ["x"] }] },
                    wanted.credentials[1],
                ],
            },
        ],
    ])("tells a request with %s apart", (_, change) => {
        expect(sameCredentialRequest({ ...wanted, ...change }, wanted)).toBe(
            false,
        );
    });
});
