import { describe, expect, it } from "vitest";
import {
    renewsOnConfigChange,
    unlistedCredentialTypes,
    usableCachedCertificate,
} from "./issuer-registration-certificate.js";

const now = () => Math.floor(Date.now() / 1000);
const jwt = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const active = jwt({ exp: now() + 3600 });
const expired = jwt({ exp: now() - 3600 });

describe("usableCachedCertificate", () => {
    it("serves an active certificate with the current fingerprint in every mode", () => {
        for (const renewal of [
            "onCredentialConfigChange",
            "onMetadataRequest",
            "manual",
        ] as const) {
            expect(
                usableCachedCertificate(
                    { jwt: active, fingerprint: "f" },
                    "f",
                    renewal,
                ),
            ).toBe(active);
        }
    });

    it("serves an outdated active certificate only in manual mode", () => {
        const cache = { jwt: active, fingerprint: "old" };
        expect(usableCachedCertificate(cache, "new", "manual")).toBe(active);
        expect(
            usableCachedCertificate(cache, "new", "onMetadataRequest"),
        ).toBeUndefined();
        expect(
            usableCachedCertificate(cache, "new", "onCredentialConfigChange"),
        ).toBeUndefined();
    });

    it("never serves an expired or missing certificate, also in manual mode", () => {
        expect(
            usableCachedCertificate(
                { jwt: expired, fingerprint: "f" },
                "f",
                "manual",
            ),
        ).toBeUndefined();
        expect(usableCachedCertificate(null, "f", "manual")).toBeUndefined();
    });
});

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

describe("renewsOnConfigChange", () => {
    it("renews generated certificates with the default renewal", () => {
        expect(renewsOnConfigChange({ enabled: true })).toBe(true);
        expect(
            renewsOnConfigChange({
                enabled: true,
                mode: "generate",
                renewal: "onCredentialConfigChange",
            }),
        ).toBe(true);
    });

    it("does not renew otherwise", () => {
        expect(renewsOnConfigChange(undefined)).toBe(false);
        expect(renewsOnConfigChange({ enabled: false })).toBe(false);
        expect(renewsOnConfigChange({ enabled: true, mode: "import" })).toBe(
            false,
        );
        expect(renewsOnConfigChange({ enabled: true, renewal: "manual" })).toBe(
            false,
        );
        expect(
            renewsOnConfigChange({
                enabled: true,
                renewal: "onMetadataRequest",
            }),
        ).toBe(false);
    });
});
