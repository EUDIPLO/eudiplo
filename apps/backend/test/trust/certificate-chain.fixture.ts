import * as x509 from "@peculiar/x509";
import { currentPeriod } from "./attestation-certificate-periods.fixture.js";

/**
 * Certificate chains of a chosen length for tests of the `x5c` and
 * `x5chain` length limit (`MAX_CERTIFICATE_CHAIN_LENGTH`).
 */

const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

/** A certificate and the keys of its subject. */
export interface IssuedCertificate {
    cert: x509.X509Certificate;
    keys: CryptoKeyPair;
}

async function keys(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
}

/** A self-signed CA certificate, current for an hour either way. */
export async function chainCa(
    name = "CN=Chain CA",
): Promise<IssuedCertificate> {
    const caKeys = await keys();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name,
        ...currentPeriod(),
        keys: caKeys,
        signingAlgorithm: algorithm,
        extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });
    return { cert, keys: caKeys };
}

/**
 * `length` certificates below `issuer`, signing certificate first, as a
 * wallet or a status list host sends them in `x5c`: each is issued by the
 * next one, the last by `issuer`, which is not part of the chain. All but
 * the signing certificate are CAs, and every one has its own subject.
 * @returns The chain, the keys of its signing certificate and the chain as
 * base64 DER
 */
export async function chainBelow(
    issuer: IssuedCertificate,
    length: number,
): Promise<{
    chain: x509.X509Certificate[];
    signingKeys: CryptoKeyPair;
    x5c: string[];
}> {
    const chain: x509.X509Certificate[] = [];
    let above = issuer;
    for (let depth = length - 1; depth >= 0; depth--) {
        const subjectKeys = await keys();
        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: (depth + 2).toString(16).padStart(2, "0"),
            subject: `CN=Chain Certificate ${depth}`,
            issuer: above.cert.subject,
            ...currentPeriod(),
            publicKey: subjectKeys.publicKey,
            signingKey: above.keys.privateKey,
            signingAlgorithm: algorithm,
            extensions: [
                new x509.BasicConstraintsExtension(depth > 0, undefined, true),
            ],
        });
        chain.unshift(cert);
        above = { cert, keys: subjectKeys };
    }
    return {
        chain,
        signingKeys: above.keys,
        x5c: chain.map((cert) => Buffer.from(cert.rawData).toString("base64")),
    };
}
