import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import {
    assertCertificatePathConstraints,
    CertificatePathConstraintViolation,
    PROCESSED_CRITICAL_EXTENSIONS,
} from "./certificate-path-constraints.util.js";

const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

// Shared code imports nothing outside `shared/` (module-boundaries.spec.ts),
// so these helpers stand in for test/trust/certificate-chain.fixture.ts.

let serial = 1;
let subjectKeys: CryptoKeyPair;

beforeAll(async () => {
    subjectKeys = (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
});

/**
 * A certificate with `extensions`. The path check reads extensions and
 * names only, so every certificate is signed with one key.
 */
function cert(
    subject: string,
    issuer: string,
    extensions: x509.Extension[],
): Promise<x509.X509Certificate> {
    return x509.X509CertificateGenerator.create({
        serialNumber: (serial++).toString(16).padStart(2, "0"),
        subject,
        issuer,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 3_600_000),
        publicKey: subjectKeys.publicKey,
        signingKey: subjectKeys.privateKey,
        signingAlgorithm: algorithm,
        extensions,
    });
}

const ca = (pathLength?: number) => [
    new x509.BasicConstraintsExtension(true, pathLength, true),
    new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
    ),
];

const signer = (extra: x509.Extension[] = []) => [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    ...extra,
];

function violation(path: x509.X509Certificate[]) {
    try {
        assertCertificatePathConstraints(path);
    } catch (error) {
        expect(error).toBeInstanceOf(CertificatePathConstraintViolation);
        return error as CertificatePathConstraintViolation;
    }
    throw new Error("expected a CertificatePathConstraintViolation");
}

describe("assertCertificatePathConstraints", () => {
    it("accepts an ISO/IEC 18013-5 Annex B document signer under its IACA", async () => {
        // IACA: basicConstraints cA pathLen 0 and keyUsage keyCertSign,
        // cRLSign, both critical; document signer: critical keyUsage
        // digitalSignature and critical extended key usage mdlDS.
        const iaca = await cert("C=DE, CN=IACA", "C=DE, CN=IACA", [
            ...ca(0),
            new x509.IssuerAlternativeNameExtension(
                [{ type: "url", value: "https://issuer.example" }],
                false,
            ),
        ]);
        const documentSigner = await cert("C=DE, CN=DS", "C=DE, CN=IACA", [
            new x509.KeyUsagesExtension(
                x509.KeyUsageFlags.digitalSignature,
                true,
            ),
            new x509.ExtendedKeyUsageExtension(["1.0.18013.5.1.2"], true),
            new x509.IssuerAlternativeNameExtension(
                [{ type: "url", value: "https://issuer.example" }],
                false,
            ),
        ]);

        expect(() =>
            assertCertificatePathConstraints([documentSigner, iaca]),
        ).not.toThrow();
    });

    it("accepts a signer alone, without basicConstraints", async () => {
        const leaf = await cert("CN=Leaf", "CN=Other", []);
        expect(() => assertCertificatePathConstraints([leaf])).not.toThrow();
    });

    it("accepts every critical extension of the processed set", async () => {
        const critical = [...PROCESSED_CRITICAL_EXTENSIONS.keys()]
            .filter((oid) => oid !== "2.5.29.19" && oid !== "2.5.29.15")
            .map((oid) => {
                switch (oid) {
                    case "2.5.29.37":
                        return new x509.ExtendedKeyUsageExtension(
                            ["1.0.18013.5.1.2"],
                            true,
                        );
                    case "2.5.29.14":
                        return new x509.SubjectKeyIdentifierExtension(
                            "0102",
                            true,
                        );
                    case "2.5.29.35":
                        return new x509.AuthorityKeyIdentifierExtension(
                            "0304",
                            true,
                        );
                    case "2.5.29.17":
                        return new x509.SubjectAlternativeNameExtension(
                            [{ type: "dns", value: "issuer.example" }],
                            true,
                        );
                    case "2.5.29.18":
                        return new x509.IssuerAlternativeNameExtension(
                            [{ type: "dns", value: "issuer.example" }],
                            true,
                        );
                    case "2.5.29.32":
                        return new x509.CertificatePolicyExtension(
                            ["2.5.29.32.0"],
                            true,
                        );
                    default:
                        throw new Error(`no test extension for ${oid}`);
                }
            });
        const root = await cert("CN=Root", "CN=Root", ca());
        const leaf = await cert("CN=Leaf", "CN=Root", signer(critical));

        expect(() =>
            assertCertificatePathConstraints([leaf, root]),
        ).not.toThrow();
    });

    it("rejects an issuer whose basicConstraints is cA FALSE, also with keyCertSign", async () => {
        const root = await cert("CN=Root", "CN=Root", ca());
        const notCa = await cert("CN=Not a CA", "CN=Root", [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(
                x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
                true,
            ),
        ]);
        const leaf = await cert("CN=Leaf", "CN=Not a CA", signer());

        const error = violation([leaf, notCa, root]);

        expect(error.index).toBe(1);
        expect(error.subject).toBe("CN=Not a CA");
        expect(error.message).toContain("is not a CA");
    });

    it("rejects an issuer without basicConstraints, the last certificate too", async () => {
        const root = await cert("CN=Root", "CN=Root", []);
        const leaf = await cert("CN=Leaf", "CN=Root", signer());

        const error = violation([leaf, root]);

        expect(error.index).toBe(1);
        expect(error.message).toContain("is not a CA");
    });

    it("rejects an issuer whose keyUsage does not assert keyCertSign", async () => {
        const root = await cert("CN=Root", "CN=Root", [
            new x509.BasicConstraintsExtension(true, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.cRLSign, true),
        ]);
        const leaf = await cert("CN=Leaf", "CN=Root", signer());

        expect(violation([leaf, root]).message).toContain("keyCertSign");
    });

    it("accepts an issuer without keyUsage", async () => {
        const root = await cert("CN=Root", "CN=Root", [
            new x509.BasicConstraintsExtension(true, undefined, true),
        ]);
        const leaf = await cert("CN=Leaf", "CN=Root", signer());

        expect(() =>
            assertCertificatePathConstraints([leaf, root]),
        ).not.toThrow();
    });

    it("rejects a CA below a root with pathLenConstraint 0", async () => {
        const root = await cert("CN=Root", "CN=Root", ca(0));
        const intermediate = await cert("CN=Intermediate", "CN=Root", ca());
        const leaf = await cert("CN=Leaf", "CN=Intermediate", signer());

        const error = violation([leaf, intermediate, root]);

        expect(error.index).toBe(2);
        expect(error.message).toContain("pathLenConstraint 0");
    });

    it("accepts as many CAs below a certificate as its pathLenConstraint allows", async () => {
        const root = await cert("CN=Root", "CN=Root", ca(1));
        const intermediate = await cert("CN=Intermediate", "CN=Root", ca(0));
        const leaf = await cert("CN=Leaf", "CN=Intermediate", signer());

        expect(() =>
            assertCertificatePathConstraints([leaf, intermediate, root]),
        ).not.toThrow();
    });

    it("does not count self-issued certificates against pathLenConstraint", async () => {
        // A key rollover certificate: issued by the root to itself under
        // the same name.
        const root = await cert("CN=Root", "CN=Root", ca(0));
        const rollover = await cert("CN=Root", "CN=Root", ca(0));
        const leaf = await cert("CN=Leaf", "CN=Root", signer());

        expect(() =>
            assertCertificatePathConstraints([leaf, rollover, root]),
        ).not.toThrow();
    });

    it("rejects a signer with an unknown critical extension", async () => {
        const root = await cert("CN=Root", "CN=Root", ca());
        const leaf = await cert(
            "CN=Leaf",
            "CN=Root",
            signer([
                new x509.Extension(
                    "1.3.6.1.4.1.55555.1.1",
                    true,
                    new Uint8Array([0x05, 0x00]),
                ),
            ]),
        );

        const error = violation([leaf, root]);

        expect(error.index).toBe(0);
        expect(error.message).toContain(
            "unsupported critical extension 1.3.6.1.4.1.55555.1.1",
        );
    });

    it("rejects a CA with critical nameConstraints, which EUDIPLO does not enforce", async () => {
        const root = await cert("CN=Root", "CN=Root", [
            ...ca(),
            new x509.Extension(
                "2.5.29.30",
                true,
                // NameConstraints { permittedSubtrees { dNSName "example" } }
                new Uint8Array([
                    0x30, 0x0d, 0xa0, 0x0b, 0x30, 0x09, 0x82, 0x07, 0x65, 0x78,
                    0x61, 0x6d, 0x70, 0x6c, 0x65,
                ]),
            ),
        ]);
        const leaf = await cert("CN=Leaf", "CN=Root", signer());

        const error = violation([leaf, root]);

        expect(error.index).toBe(1);
        expect(error.message).toContain(
            "unsupported critical extension 2.5.29.30",
        );
    });

    it("accepts an unknown extension that is not critical", async () => {
        const root = await cert("CN=Root", "CN=Root", ca());
        const leaf = await cert(
            "CN=Leaf",
            "CN=Root",
            signer([
                new x509.Extension(
                    "1.3.6.1.4.1.55555.1.1",
                    false,
                    new Uint8Array([0x05, 0x00]),
                ),
            ]),
        );

        expect(() =>
            assertCertificatePathConstraints([leaf, root]),
        ).not.toThrow();
    });
});
