import { describe, expect, it } from "vitest";
import {
    deriveRegistrationCertificateMaterial,
    isJwtActive,
    unlistedCredentialTypes,
} from "./issuer-registration-certificate.js";

const now = () => Math.floor(Date.now() / 1000);
const jwt = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const publicUrl = "https://issuer.example";
const configs = [
    {
        id: "mdl",
        config: { format: "mso_mdoc", docType: "org.iso.18013.5.1.mDL" },
    },
    {
        id: "pid",
        config: { format: "dc+sd-jwt" },
        vct: "urn:eudi:pid:de:1",
        schemaMeta: { id: "https://schemas.example/pid", version: "1.0" },
    },
    {
        id: "pid-copy",
        config: { format: "dc+sd-jwt" },
        vct: "urn:eudi:pid:de:1",
    },
    {
        id: "hosted",
        config: { format: "dc+sd-jwt" },
        vct: { name: "Hosted" },
    },
    { id: "other", config: { format: "jwt_vc" }, vct: "urn:other" },
    { id: "none", config: { format: "dc+sd-jwt" }, vct: null },
    { id: "blank-vct", config: { format: "dc+sd-jwt" }, vct: " " },
    { id: "blank", config: { format: "mso_mdoc", docType: " " } },
    { id: "padded", config: { format: "dc+sd-jwt" }, vct: " urn:padded " },
];
const types = [
    { format: "dc+sd-jwt", type: " urn:padded " },
    {
        format: "dc+sd-jwt",
        type: "https://issuer.example/issuers/t/credentials-metadata/vct/hosted",
    },
    { format: "mso_mdoc", type: "org.iso.18013.5.1.mDL" },
    { format: "dc+sd-jwt", type: "urn:eudi:pid:de:1" },
];

describe("unlistedCredentialTypes", () => {
    const material = {
        providesAttestations: [
            { format: "dc+sd-jwt" as const, type: "urn:pid" },
            { format: "mso_mdoc" as const, type: "org.iso.18013.5.1.mDL" },
        ],
    };

    it("finds nothing when every type is listed with its format", () => {
        expect(
            unlistedCredentialTypes(
                {
                    provides_attestations: [
                        {
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["urn:pid"] },
                        },
                        {
                            format: "mso_mdoc",
                            meta: { doctype_value: "org.iso.18013.5.1.mDL" },
                        },
                    ],
                },
                material,
            ),
        ).toEqual([]);
    });

    it("lists the types a certificate leaves out or names in another format", () => {
        expect(unlistedCredentialTypes({}, material)).toEqual([
            "urn:pid",
            "org.iso.18013.5.1.mDL",
        ]);
        expect(
            unlistedCredentialTypes(
                {
                    provides_attestations: [
                        {
                            format: "mso_mdoc",
                            meta: { doctype_value: "urn:pid" },
                        },
                    ],
                },
                material,
            ),
        ).toEqual(["urn:pid", "org.iso.18013.5.1.mDL"]);
    });

    it("compares trimmed values, as the registrar trims them", () => {
        expect(
            unlistedCredentialTypes(
                {
                    provides_attestations: [
                        {
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["urn:padded"] },
                        },
                    ],
                },
                {
                    providesAttestations: [
                        { format: "dc+sd-jwt" as const, type: " urn:padded " },
                    ],
                },
            ),
        ).toEqual([]);
    });
});

describe("issuer registration certificate material", () => {
    it("derives the sorted vct and docType values as stored, not schema metadata", () => {
        expect(
            deriveRegistrationCertificateMaterial(configs, publicUrl, "t"),
        ).toEqual({ providesAttestations: types });
    });

    it("keeps a type listed in both formats once per format", () => {
        expect(
            deriveRegistrationCertificateMaterial(
                [
                    { id: "a", config: { format: "mso_mdoc", docType: "x" } },
                    { id: "b", config: { format: "dc+sd-jwt" }, vct: "x" },
                    { id: "c", config: { format: "mso_mdoc", docType: "x" } },
                ],
                publicUrl,
                "t",
            ),
        ).toEqual({
            providesAttestations: [
                { format: "dc+sd-jwt", type: "x" },
                { format: "mso_mdoc", type: "x" },
            ],
        });
    });

    it("finds nothing without a vct or docType", () => {
        expect(
            deriveRegistrationCertificateMaterial(
                configs.filter((config) =>
                    ["other", "none", "blank-vct", "blank"].includes(config.id),
                ),
                publicUrl,
                "t",
            ),
        ).toEqual({ providesAttestations: [] });
    });

    it("checks the validity window with clock skew", () => {
        expect(isJwtActive(jwt({ exp: now() + 3600 }))).toBe(true);
        expect(isJwtActive(jwt({ exp: now() - 3600 }))).toBe(false);
        expect(isJwtActive(jwt({ exp: now() - 10 }))).toBe(true);
        expect(isJwtActive(jwt({ nbf: now() + 3600 }))).toBe(false);
        expect(isJwtActive("not-a-jwt")).toBe(false);
    });
});
