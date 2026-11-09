import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import { DbKmsAdapter } from "../kms/adapters/db-kms.adapter.js";
import type { KmsKeyRef } from "../kms/kms-adapter.js";
import {
    importPublicCryptoKey,
    KmsCryptoProvider,
    makeKmsSigningKey,
} from "../kms/kms-crypto-provider.js";
import { CertificateBuilderService } from "./certificate-builder.service.js";

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
        hostname: "issuer.example",
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 86_400_000),
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

        const selfSignedPem = await builder.createSelfSignedCert(
            adapter,
            ref,
            "leaf",
            "issuer.example",
            notBefore,
            notAfter,
        );
        // The generated CA signs the leaf, as for an internal chain.
        const { caCertPem: caPem, leaf } = await signLeaf((caAdapter, caRef) =>
            builder.createSelfSignedCaCert(
                caAdapter,
                caRef,
                "CA",
                "issuer.example",
                notBefore,
                notAfter,
            ),
        );

        expect(keyUsages(caPem)).toBe(
            x509.KeyUsageFlags.digitalSignature |
                x509.KeyUsageFlags.keyCertSign,
        );
        expect(keyUsages(selfSignedPem)).toBe(
            x509.KeyUsageFlags.digitalSignature,
        );
        expect(leaf.getExtension(x509.KeyUsagesExtension)?.usages).toBe(
            x509.KeyUsageFlags.digitalSignature,
        );
    });
});
