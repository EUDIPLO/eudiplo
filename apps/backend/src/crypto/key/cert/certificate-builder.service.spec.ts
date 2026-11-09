import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import { registerTolerantX509Extensions } from "../../../shared/utils/x509-tolerant-extensions.js";
import {
    MDL_DOCUMENT_SIGNER_EKU,
    type SigningCertificateProfile,
} from "../domain/signing-certificate-profile.js";
import { DbKmsAdapter } from "../kms/adapters/db-kms.adapter.js";
import type { KmsKeyRef } from "../kms/kms-adapter.js";
import {
    importPublicCryptoKey,
    KmsCryptoProvider,
    makeKmsSigningKey,
} from "../kms/kms-crypto-provider.js";
import { CertificateBuilderService } from "./certificate-builder.service.js";

const PUBLIC_URL = "https://issuer.example/eudiplo";

/** A CA certificate with the given subject, as an imported CA would have. */
async function caCertificate(
    adapter: DbKmsAdapter,
    ref: KmsKeyRef,
    subject: x509.Name | string,
    extensions: x509.Extension[] = [],
): Promise<string> {
    const publicKey = await importPublicCryptoKey(ref.publicJwk, ref.alg);
    const cert = await x509.X509CertificateGenerator.create({
        serialNumber: "01",
        subject,
        issuer: subject,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signingKey: makeKmsSigningKey(adapter, ref, ref.alg),
        extensions: [
            new x509.BasicConstraintsExtension(true, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
            ...extensions,
        ],
    });
    return cert.toString("pem");
}

/** A CA key and a leaf key, and a leaf signed by a CA built from the first. */
async function signLeaf(
    buildCa: (adapter: DbKmsAdapter, caRef: KmsKeyRef) => Promise<string>,
    profile: SigningCertificateProfile = "default",
): Promise<{
    caRef: KmsKeyRef;
    caCertPem: string;
    leaf: x509.X509Certificate;
}> {
    const adapter = new DbKmsAdapter("db");
    const { ref: caRef } = await adapter.generateKey({
        kid: "ca",
        alg: "ES256",
    });
    const { ref: leafRef } = await adapter.generateKey({
        kid: "leaf",
        alg: "ES256",
    });
    const caCertPem = await buildCa(adapter, caRef);
    const { cert } = await new CertificateBuilderService().createCaSignedCert({
        caAdapter: adapter,
        caRef,
        caCertPem,
        subjectPublicJwk: leafRef.publicJwk,
        subjectCN: "leaf",
        publicUrl: PUBLIC_URL,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 86_400_000),
        profile,
    });
    return { caRef, caCertPem, leaf: new x509.X509Certificate(cert) };
}

function authorityKeyId(cert: x509.X509Certificate): string | undefined {
    return cert.getExtension(x509.AuthorityKeyIdentifierExtension)?.keyId;
}

describe("CertificateBuilderService.createCaSignedCert", () => {
    beforeAll(() => {
        x509.cryptoProvider.set(new KmsCryptoProvider());
    });

    // OpenSSL 3 encodes subject attributes as UTF8String by default, while a
    // name re-encoded from its string form uses PrintableString where it can.
    it.each([
        [
            "a UTF8String common name",
            new x509.Name([
                { C: [{ printableString: "IE" }] },
                { CN: [{ utf8String: "Test CA" }] },
            ]),
        ],
        [
            "a multi-valued RDN with a BMPString",
            new x509.Name([
                { C: [{ printableString: "IE" }] },
                {
                    O: [{ utf8String: "Acme" }],
                    OU: [{ bmpString: "Ünïcode Dept" }],
                },
                { CN: [{ utf8String: "Test CA" }] },
            ]),
        ],
    ])(
        "copies the CA subject with %s byte for byte into the issuer",
        async (_label, subject) => {
            const subjectDer = Buffer.from(subject.toArrayBuffer());
            const { caCertPem, leaf } = await signLeaf((adapter, caRef) =>
                caCertificate(adapter, caRef, subject),
            );
            expect(
                Buffer.from(
                    new x509.X509Certificate(caCertPem).rawData,
                ).includes(subjectDer),
            ).toBe(true);

            expect(
                Buffer.from(leaf.issuerName.toArrayBuffer()).equals(subjectDer),
            ).toBe(true);
            // The leaf's own subject is C=DE, CN=leaf, so the CA subject
            // bytes can only appear in the leaf as its issuer.
            expect(Buffer.from(leaf.rawData).includes(subjectDer)).toBe(true);
        },
    );

    it("copies the CA's subject key identifier into the authority key identifier", async () => {
        // Not the SHA-1 of the key: e.g. a truncated SHA-256 (RFC 7093) or
        // a random value, as other CAs use.
        const caKeyId = "0102030405060708090a0b0c0d0e0f1011121314";
        const { leaf } = await signLeaf((adapter, caRef) =>
            caCertificate(adapter, caRef, "C=IE, CN=Test CA", [
                new x509.SubjectKeyIdentifierExtension(caKeyId),
            ]),
        );

        expect(authorityKeyId(leaf)).toBe(caKeyId);
    });

    it("derives the authority key identifier from the CA key when the CA has no subject key identifier", async () => {
        const { caRef, leaf } = await signLeaf((adapter, caRef) =>
            caCertificate(adapter, caRef, "C=IE, CN=Test CA"),
        );

        const expected = await x509.SubjectKeyIdentifierExtension.create(
            await importPublicCryptoKey(caRef.publicJwk, caRef.alg),
        );
        expect(authorityKeyId(leaf)).toBe(expected.keyId);
    });
});

describe("CertificateBuilderService key usages", () => {
    beforeAll(() => {
        x509.cryptoProvider.set(new KmsCryptoProvider());
    });

    function keyUsages(pem: string): number | undefined {
        return new x509.X509Certificate(pem).getExtension(
            x509.KeyUsagesExtension,
        )?.usages;
    }

    // RFC 5480 3 does not allow keyEncipherment for id-ecPublicKey, and the
    // ISO/IEC 18013-5 document signer profile expects digitalSignature only.
    it("marks EC certificates for signing only, without keyEncipherment", async () => {
        const adapter = new DbKmsAdapter("db");
        const { ref } = await adapter.generateKey({ kid: "k", alg: "ES256" });
        const builder = new CertificateBuilderService();
        const notBefore = new Date(Date.now() - 60_000);
        const notAfter = new Date(Date.now() + 86_400_000);

        const selfSignedPem = await builder.createSelfSignedCert({
            adapter,
            ref,
            subjectCN: "leaf",
            publicUrl: PUBLIC_URL,
            notBefore,
            notAfter,
            profile: "documentSigner",
        });
        // The generated CA signs the leaf, as for an internal chain.
        const { caCertPem: caPem, leaf } = await signLeaf(
            (caAdapter, caRef) =>
                builder.createSelfSignedCaCert(
                    caAdapter,
                    caRef,
                    "CA",
                    PUBLIC_URL,
                    notBefore,
                    notAfter,
                ),
            "documentSigner",
        );

        expect(keyUsages(caPem)).toBe(
            x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        );
        expect(keyUsages(selfSignedPem)).toBe(
            x509.KeyUsageFlags.digitalSignature,
        );
        expect(leaf.getExtension(x509.KeyUsagesExtension)?.usages).toBe(
            x509.KeyUsageFlags.digitalSignature,
        );
    });
});

/** OIDs of the extensions ISO/IEC 18013-5 Annex B names. */
const CRL_DISTRIBUTION_POINTS = "2.5.29.31";
const ISSUER_ALT_NAME = "2.5.29.18";

function issuerAltNameUrls(cert: x509.X509Certificate): string[] {
    const ian = cert.extensions.find((e) => e.type === ISSUER_ALT_NAME);
    if (!ian) return [];
    return new x509.IssuerAlternativeNameExtension(ian.rawData).names
        .toJSON()
        .filter((n) => n.type === "url")
        .map((n) => n.value);
}

function extendedKeyUsage(
    cert: x509.X509Certificate,
): x509.ExtendedKeyUsageExtension | undefined {
    return cert.getExtension(x509.ExtendedKeyUsageExtension) ?? undefined;
}

describe("CertificateBuilderService IACA profile (ISO/IEC 18013-5 B.1.2)", () => {
    beforeAll(() => {
        x509.cryptoProvider.set(new KmsCryptoProvider());
    });

    async function generatedRoot(): Promise<x509.X509Certificate> {
        const adapter = new DbKmsAdapter("db");
        const { ref } = await adapter.generateKey({ kid: "ca", alg: "ES256" });
        return new x509.X509Certificate(
            await new CertificateBuilderService().createSelfSignedCaCert(
                adapter,
                ref,
                "Tenant Root CA",
                PUBLIC_URL,
                new Date(Date.now() - 60_000),
                new Date(Date.now() + 86_400_000),
            ),
        );
    }

    it("is a CA that signs end-entity certificates only, with critical basic constraints and key usage", async () => {
        const root = await generatedRoot();

        const basicConstraints = root.getExtension(
            x509.BasicConstraintsExtension,
        );
        expect(basicConstraints?.ca).toBe(true);
        expect(basicConstraints?.pathLength).toBe(0);
        expect(basicConstraints?.critical).toBe(true);
        const keyUsage = root.getExtension(x509.KeyUsagesExtension);
        expect(keyUsage?.usages).toBe(
            x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        );
        expect(keyUsage?.critical).toBe(true);
        expect(
            root.getExtension(x509.SubjectKeyIdentifierExtension),
        ).toBeTruthy();
    });

    it("has a random serial number of at least 63 bits and at most 20 octets", async () => {
        const [a, b] = await Promise.all([generatedRoot(), generatedRoot()]);

        expect(a.serialNumber).not.toBe(b.serialNumber);
        for (const cert of [a, b]) {
            const octets = cert.serialNumber.length / 2;
            expect(octets).toBeGreaterThanOrEqual(8);
            expect(octets).toBeLessThanOrEqual(20);
        }
    });

    it("names PUBLIC_URL in a non-critical IssuerAlternativeName and no CRL distribution point", async () => {
        const root = await generatedRoot();

        expect(issuerAltNameUrls(root)).toEqual([PUBLIC_URL]);
        expect(
            root.extensions.find((e) => e.type === ISSUER_ALT_NAME)?.critical,
        ).toBe(false);
        expect(
            root.extensions.some((e) => e.type === CRL_DISTRIBUTION_POINTS),
        ).toBe(false);
    });
});

describe("CertificateBuilderService document signer profile (ISO/IEC 18013-5 B.1.4)", () => {
    beforeAll(() => {
        x509.cryptoProvider.set(new KmsCryptoProvider());
        // As at bootstrap, so a CA certificate with a malformed
        // IssuerAlternativeName parses at all.
        registerTolerantX509Extensions();
    });

    it("adds the critical mDL document signer EKU and the generated CA's IssuerAlternativeName", async () => {
        const builder = new CertificateBuilderService();
        const { caCertPem, leaf } = await signLeaf(
            (adapter, caRef) =>
                builder.createSelfSignedCaCert(
                    adapter,
                    caRef,
                    "Tenant Root CA",
                    PUBLIC_URL,
                    new Date(Date.now() - 60_000),
                    new Date(Date.now() + 86_400_000),
                ),
            "documentSigner",
        );

        const eku = extendedKeyUsage(leaf);
        expect(eku?.usages).toEqual([MDL_DOCUMENT_SIGNER_EKU]);
        expect(eku?.critical).toBe(true);
        expect(issuerAltNameUrls(leaf)).toEqual(
            issuerAltNameUrls(new x509.X509Certificate(caCertPem)),
        );
        expect(
            leaf.extensions.some((e) => e.type === CRL_DISTRIBUTION_POINTS),
        ).toBe(false);
        expect(leaf.subject).toBe("C=DE, CN=leaf");
    });

    it("copies an imported CA's IssuerAlternativeName, country and state into the document signer", async () => {
        // Critical in the CA, to show the copy is always non-critical.
        const caIan = new x509.IssuerAlternativeNameExtension(
            [{ type: "email", value: "iaca@authority.example" }],
            true,
        );
        const { leaf } = await signLeaf(
            (adapter, caRef) =>
                caCertificate(
                    adapter,
                    caRef,
                    "C=IE, ST=Dublin, O=Authority, CN=Test IACA",
                    [caIan],
                ),
            "documentSigner",
        );

        const leafIan = leaf.extensions.find((e) => e.type === ISSUER_ALT_NAME);
        expect(
            Buffer.from(leafIan!.value).equals(Buffer.from(caIan.value)),
        ).toBe(true);
        expect(leafIan?.critical).toBe(false);
        expect(leaf.subject).toBe("C=IE, ST=Dublin, CN=leaf");
    });

    it("names PUBLIC_URL as issuer when the imported CA has no IssuerAlternativeName", async () => {
        const { leaf } = await signLeaf(
            (adapter, caRef) =>
                caCertificate(adapter, caRef, "C=IE, CN=Test CA"),
            "documentSigner",
        );

        expect(issuerAltNameUrls(leaf)).toEqual([PUBLIC_URL]);
        expect(leaf.subject).toBe("C=IE, CN=leaf");
    });

    it("adds the EKU and IssuerAlternativeName to a self-signed attestation certificate", async () => {
        const adapter = new DbKmsAdapter("db");
        const { ref } = await adapter.generateKey({ kid: "k", alg: "ES256" });
        const cert = new x509.X509Certificate(
            await new CertificateBuilderService().createSelfSignedCert({
                adapter,
                ref,
                subjectCN: "leaf",
                publicUrl: PUBLIC_URL,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 86_400_000),
                profile: "documentSigner",
            }),
        );

        expect(extendedKeyUsage(cert)?.usages).toEqual([
            MDL_DOCUMENT_SIGNER_EKU,
        ]);
        expect(extendedKeyUsage(cert)?.critical).toBe(true);
        expect(issuerAltNameUrls(cert)).toEqual([PUBLIC_URL]);
    });

    it("names PUBLIC_URL instead of copying a CA IssuerAlternativeName that is no GeneralNames", async () => {
        // The malformed variant of some reference IACAs: the value wraps a
        // whole Extension instead of the GeneralNames.
        const wrapped = new x509.IssuerAlternativeNameExtension([
            { type: "url", value: "https://iaca.example" },
        ]);
        const { leaf } = await signLeaf(
            (adapter, caRef) =>
                caCertificate(adapter, caRef, "C=IE, CN=Test IACA", [
                    new x509.Extension(ISSUER_ALT_NAME, false, wrapped.rawData),
                ]),
            "documentSigner",
        );

        expect(issuerAltNameUrls(leaf)).toEqual([PUBLIC_URL]);
    });

    it("writes PUBLIC_URL as configured, without adding a trailing slash", async () => {
        const adapter = new DbKmsAdapter("db");
        const { ref } = await adapter.generateKey({ kid: "k", alg: "ES256" });
        const root = new x509.X509Certificate(
            await new CertificateBuilderService().createSelfSignedCaCert(
                adapter,
                ref,
                "Tenant Root CA",
                "https://issuer.example",
                new Date(Date.now() - 60_000),
                new Date(Date.now() + 86_400_000),
            ),
        );

        expect(issuerAltNameUrls(root)).toEqual(["https://issuer.example"]);
    });

    it("leaves certificates of other usage types without EKU and IssuerAlternativeName", async () => {
        const adapter = new DbKmsAdapter("db");
        const { ref } = await adapter.generateKey({ kid: "k", alg: "ES256" });
        const selfSigned = new x509.X509Certificate(
            await new CertificateBuilderService().createSelfSignedCert({
                adapter,
                ref,
                subjectCN: "leaf",
                publicUrl: PUBLIC_URL,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 86_400_000),
                profile: "default",
            }),
        );
        const { leaf } = await signLeaf((caAdapter, caRef) =>
            caCertificate(caAdapter, caRef, "C=IE, CN=Test CA", [
                new x509.IssuerAlternativeNameExtension([
                    { type: "url", value: "https://ca.example" },
                ]),
            ]),
        );

        for (const cert of [selfSigned, leaf]) {
            expect(extendedKeyUsage(cert)).toBeUndefined();
            expect(issuerAltNameUrls(cert)).toEqual([]);
            expect(cert.subject).toBe("C=DE, CN=leaf");
        }
    });
});
