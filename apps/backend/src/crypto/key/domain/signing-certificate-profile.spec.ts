import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { KeyUsageType } from "../types/key-usage-type.js";
import {
    documentSignerSubject,
    signingCertificateProfile,
} from "./signing-certificate-profile.js";

describe("signingCertificateProfile", () => {
    it("gives the signing certificates of attestation key chains the document signer profile, and only those", () => {
        for (const usageType of Object.values(KeyUsageType)) {
            expect(signingCertificateProfile(usageType)).toBe(
                usageType === KeyUsageType.Attestation
                    ? "documentSigner"
                    : "default",
            );
        }
    });
});

describe("documentSignerSubject", () => {
    const subject = (caSubject: string) =>
        documentSignerSubject(new x509.Name(caSubject), "DS").toString();

    it("takes country and state from the CA and drops its other attributes", () => {
        expect(subject("C=IE, ST=Dublin, O=Authority, CN=Test IACA")).toBe(
            "C=IE, ST=Dublin, CN=DS",
        );
    });

    it("leaves out the state when the CA names none", () => {
        expect(subject("C=IE, CN=Test IACA")).toBe("C=IE, CN=DS");
    });

    it("falls back to DE when the CA names no country", () => {
        expect(subject("O=Authority, CN=Test CA")).toBe("C=DE, CN=DS");
    });

    it("keeps the encoding of the CA's country and state values", () => {
        const ca = new x509.Name([
            { C: [{ utf8String: "IE" }] },
            { ST: [{ utf8String: "Dublin" }] },
            { CN: [{ utf8String: "Test IACA" }] },
        ]);
        const country = Buffer.from(
            new x509.Name([{ C: [{ utf8String: "IE" }] }]).toArrayBuffer(),
        ).subarray(4);
        const state = Buffer.from(
            new x509.Name([{ ST: [{ utf8String: "Dublin" }] }]).toArrayBuffer(),
        ).subarray(4);

        const ds = Buffer.from(documentSignerSubject(ca, "DS").toArrayBuffer());

        // The AttributeTypeAndValue bytes of the CA appear unchanged, not
        // re-encoded as the PrintableString the library would choose.
        expect(ds.includes(country)).toBe(true);
        expect(ds.includes(state)).toBe(true);
    });
});
