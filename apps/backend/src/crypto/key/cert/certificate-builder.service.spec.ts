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
    subject: x509.Name,
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
        ],
    });
    return cert.toString("pem");
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
            const adapter = new DbKmsAdapter("db");
            const { ref: caRef } = await adapter.generateKey({
                kid: "ca",
                alg: "ES256",
            });
            const { ref: leafRef } = await adapter.generateKey({
                kid: "leaf",
                alg: "ES256",
            });
            const caCertPem = await caCertificate(adapter, caRef, subject);
            const subjectDer = Buffer.from(subject.toArrayBuffer());
            expect(
                Buffer.from(
                    new x509.X509Certificate(caCertPem).rawData,
                ).includes(subjectDer),
            ).toBe(true);

            const { cert } =
                await new CertificateBuilderService().createCaSignedCert({
                    caAdapter: adapter,
                    caRef,
                    caCertPem,
                    subjectPublicJwk: leafRef.publicJwk,
                    subjectCN: "leaf",
                    hostname: "issuer.example",
                    notBefore: new Date(Date.now() - 60_000),
                    notAfter: new Date(Date.now() + 86_400_000),
                });

            const leaf = new x509.X509Certificate(cert);
            expect(
                Buffer.from(leaf.issuerName.toArrayBuffer()).equals(subjectDer),
            ).toBe(true);
            // The leaf's own subject is C=DE, CN=leaf, so the CA subject
            // bytes can only appear in the leaf as its issuer.
            expect(Buffer.from(leaf.rawData).includes(subjectDer)).toBe(true);
        },
    );
});
