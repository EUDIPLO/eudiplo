import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CertificatePathBuilder,
    CertificatePathLimitExceeded,
    MAX_CERTIFICATE_PATH_LENGTH,
    MAX_PATH_SIGNATURE_CHECKS,
} from "./certificate-path.util.js";

const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

const der = (path: x509.X509Certificate[]) =>
    path.map((cert) => Buffer.from(cert.rawData).toString("base64"));

/** Signature checks the path builder makes, counted on `X509Certificate.verify`. */
const signatureChecks = () =>
    vi.spyOn(x509.X509Certificate.prototype, "verify");

// Shared code imports nothing outside `shared/` (module-boundaries.spec.ts),
// so these helpers stand in for test/trust/certificate-chain.fixture.ts.

/** A certificate and the keys of its subject. */
interface IssuedCertificate {
    cert: x509.X509Certificate;
    keys: CryptoKeyPair;
}

const currentPeriod = () => ({
    notBefore: new Date(Date.now() - 3_600_000),
    notAfter: new Date(Date.now() + 3_600_000),
});

const caExtensions = () => [
    new x509.BasicConstraintsExtension(true, undefined, true),
];

async function keys(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey(algorithm, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
}

/** A certificate for `subject` signed by `issuerKeys`, with extensions. */
async function issued(
    subject: string,
    issuer: string,
    subjectKeys: CryptoKeyPair,
    issuerKeys: CryptoKeyPair,
    extensions: x509.Extension[] = [],
): Promise<x509.X509Certificate> {
    return x509.X509CertificateGenerator.create({
        serialNumber: "0a",
        subject,
        issuer,
        ...currentPeriod(),
        publicKey: subjectKeys.publicKey,
        signingKey: issuerKeys.privateKey,
        signingAlgorithm: algorithm,
        extensions,
    });
}

/** A self-signed CA certificate. */
async function chainCa(name = "CN=Chain CA"): Promise<IssuedCertificate> {
    const caKeys = await keys();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name,
        ...currentPeriod(),
        keys: caKeys,
        signingAlgorithm: algorithm,
        extensions: caExtensions(),
    });
    return { cert, keys: caKeys };
}

/**
 * `length` certificates below `issuer`, signing certificate first, each
 * issued by the next and the last by `issuer`; all but the first are CAs.
 */
async function chainBelow(
    issuer: IssuedCertificate,
    length: number,
): Promise<{ chain: x509.X509Certificate[] }> {
    const chain: x509.X509Certificate[] = [];
    let above = issuer;
    for (let depth = length - 1; depth >= 0; depth--) {
        const subjectKeys = await keys();
        const cert = await issued(
            `CN=Chain Certificate ${depth}`,
            above.cert.subject,
            subjectKeys,
            above.keys,
            depth > 0 ? caExtensions() : [],
        );
        chain.unshift(cert);
        above = { cert, keys: subjectKeys };
    }
    return { chain };
}

/**
 * `count` self-signed CA certificates named `name`, with a key of their own
 * and no subject key identifier: none verifies a certificate of `name`.
 */
async function sameSubjectCertificates(
    name: string,
    count: number,
): Promise<x509.X509Certificate[]> {
    const decoyKeys = await keys();
    const certificates: x509.X509Certificate[] = [];
    for (let i = 0; i < count; i++) {
        certificates.push(
            await x509.X509CertificateGenerator.createSelfSigned({
                serialNumber: (i + 0x100).toString(16),
                name,
                ...currentPeriod(),
                keys: decoyKeys,
                signingAlgorithm: algorithm,
                extensions: caExtensions(),
            }),
        );
    }
    return certificates;
}

/** A second self-signed CA with the subject and key of `ca`. */
async function renewal(ca: IssuedCertificate): Promise<x509.X509Certificate> {
    return x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "7f",
        name: ca.cert.subject,
        ...currentPeriod(),
        keys: ca.keys,
        signingAlgorithm: algorithm,
        extensions: caExtensions(),
    });
}

describe("CertificatePathBuilder", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("builds the path that X509ChainBuilder.build builds", async () => {
        const ca = await chainCa();
        const { chain } = await chainBelow(ca, 3);
        const pool = [chain[2], ca.cert, chain[0], chain[1]];

        const path = await new CertificatePathBuilder(pool).build(chain[0]);

        expect(der(path)).toEqual([...der(chain), ...der([ca.cert])]);
        expect(der(path)).toEqual(
            der(
                await new x509.X509ChainBuilder({ certificates: pool }).build(
                    chain[0],
                ),
            ),
        );
    });

    it("takes the first certificate in pool order when two share subject and key", async () => {
        const ca = await chainCa();
        const other = await renewal(ca);
        const { chain } = await chainBelow(ca, 1);

        await expect(
            new CertificatePathBuilder([other, ca.cert]).build(chain[0]),
        ).resolves.toEqual([chain[0], other]);
        await expect(
            new CertificatePathBuilder([ca.cert, other]).build(chain[0]),
        ).resolves.toEqual([chain[0], ca.cert]);
    });

    it("ends the path where no issuer is in the pool", async () => {
        const ca = await chainCa();
        const { chain } = await chainBelow(ca, 2);

        await expect(
            new CertificatePathBuilder([chain[1]]).build(chain[0]),
        ).resolves.toEqual(chain);
    });

    it("skips a candidate whose subject key identifier differs from the authority key identifier, without checking its signature", async () => {
        const caKeys = await keys();
        const leafKeys = await keys();
        const ca = await issued("CN=CA", "CN=CA", caKeys, caKeys, [
            new x509.SubjectKeyIdentifierExtension("0102"),
        ]);
        const leaf = await issued("CN=Leaf", "CN=CA", leafKeys, caKeys, [
            new x509.AuthorityKeyIdentifierExtension("0304"),
        ]);
        const verify = signatureChecks();

        await expect(
            new CertificatePathBuilder([ca]).build(leaf),
        ).resolves.toEqual([leaf]);
        expect(verify).not.toHaveBeenCalled();
    });

    it("keeps looking for the issuer of a certificate that names itself as issuer but is signed by another key", async () => {
        const oldCa = await chainCa("CN=CA");
        const link = await issued("CN=CA", "CN=CA", await keys(), oldCa.keys, [
            ...caExtensions(),
        ]);

        await expect(
            new CertificatePathBuilder([oldCa.cert]).build(link),
        ).resolves.toEqual([link, oldCa.cert]);
    });

    it("skips a candidate whose signature check throws", async () => {
        const ca = await chainCa();
        const [throwing] = await sameSubjectCertificates(ca.cert.subject, 1);
        const { chain } = await chainBelow(ca, 1);
        const verify = x509.X509Certificate.prototype.verify;
        vi.spyOn(x509.X509Certificate.prototype, "verify").mockImplementation(
            function (this: x509.X509Certificate, params, crypto) {
                if (params?.publicKey === throwing) {
                    return Promise.reject(new Error("unsupported key"));
                }
                return verify.call(this, params, crypto);
            },
        );

        await expect(
            new CertificatePathBuilder([throwing, ca.cert]).build(chain[0]),
        ).resolves.toEqual([chain[0], ca.cert]);
    });

    it("skips a candidate with a key of another curve", async () => {
        const ca = await chainCa();
        const p384Keys = (await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-384" },
            true,
            ["sign", "verify"],
        )) as CryptoKeyPair;
        const p384Ca = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: "02",
            name: ca.cert.subject,
            ...currentPeriod(),
            keys: p384Keys,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-384" },
            extensions: caExtensions(),
        });
        const { chain } = await chainBelow(ca, 1);

        await expect(
            new CertificatePathBuilder([p384Ca, ca.cert]).build(chain[0]),
        ).resolves.toEqual([chain[0], ca.cert]);
    });

    it("refuses a path that would hold a certificate twice", async () => {
        const aKeys = await keys();
        const bKeys = await keys();
        const a = await issued("CN=A", "CN=B", aKeys, bKeys);
        const b = await issued("CN=B", "CN=A", bKeys, aKeys);
        const leaf = await issued("CN=Leaf", "CN=A", await keys(), aKeys);

        await expect(
            new CertificatePathBuilder([a, b]).build(leaf),
        ).rejects.toThrow(
            "Cannot build a certificate chain. Circular dependency.",
        );
    });

    describe("path length", () => {
        it(`builds a path of ${MAX_CERTIFICATE_PATH_LENGTH} certificates`, async () => {
            const ca = await chainCa();
            const { chain } = await chainBelow(
                ca,
                MAX_CERTIFICATE_PATH_LENGTH - 1,
            );

            await expect(
                new CertificatePathBuilder([...chain, ca.cert]).build(chain[0]),
            ).resolves.toHaveLength(MAX_CERTIFICATE_PATH_LENGTH);
        });

        it(`refuses a path of ${MAX_CERTIFICATE_PATH_LENGTH + 1} certificates`, async () => {
            const ca = await chainCa();
            const { chain } = await chainBelow(ca, MAX_CERTIFICATE_PATH_LENGTH);

            const built = new CertificatePathBuilder([...chain, ca.cert]).build(
                chain[0],
            );
            await expect(built).rejects.toBeInstanceOf(
                CertificatePathLimitExceeded,
            );
            await expect(built).rejects.toMatchObject({
                limit: "length",
                message: "Certificate path is longer than 16 certificates",
            });
        });
    });

    // Each certificate in the pool with the issuer's subject costs a
    // signature check; whoever controls a trust list decides how many there
    // are.
    describe("signature checks", () => {
        /**
         * A pool with `decoys` certificates named like the CA, which do not
         * verify, before the CA: building the path from the signing
         * certificate below the CA checks each decoy, the CA, and that the
         * CA is self-signed.
         */
        async function poolWithDecoys(decoys: number) {
            const ca = await chainCa();
            const { chain } = await chainBelow(ca, 1);
            const pool = [
                ...(await sameSubjectCertificates(ca.cert.subject, decoys)),
                ca.cert,
            ];
            return { leaf: chain[0], ca: ca.cert, pool };
        }

        it(`builds a path that takes ${MAX_PATH_SIGNATURE_CHECKS} checks`, async () => {
            const { leaf, ca, pool } = await poolWithDecoys(
                MAX_PATH_SIGNATURE_CHECKS - 2,
            );
            const verify = signatureChecks();

            await expect(
                new CertificatePathBuilder(pool).build(leaf),
            ).resolves.toEqual([leaf, ca]);
            expect(verify).toHaveBeenCalledTimes(MAX_PATH_SIGNATURE_CHECKS);
        });

        it(`refuses a path that takes ${MAX_PATH_SIGNATURE_CHECKS + 1} checks`, async () => {
            const { leaf, pool } = await poolWithDecoys(
                MAX_PATH_SIGNATURE_CHECKS - 1,
            );

            await expect(
                new CertificatePathBuilder(pool).build(leaf),
            ).rejects.toMatchObject({
                name: "CertificatePathLimitExceeded",
                limit: "signatureChecks",
                message:
                    "Certificate path not found within 64 signature checks",
            });
        });

        it("stops after the limit however many certificates share the issuer's subject", async () => {
            const { leaf, pool } = await poolWithDecoys(300);
            const verify = signatureChecks();

            await expect(
                new CertificatePathBuilder(pool).build(leaf),
            ).rejects.toBeInstanceOf(CertificatePathLimitExceeded);
            expect(verify).toHaveBeenCalledTimes(MAX_PATH_SIGNATURE_CHECKS);
        });

        it("counts the checks of each path on its own", async () => {
            const { leaf, ca, pool } = await poolWithDecoys(
                MAX_PATH_SIGNATURE_CHECKS - 2,
            );
            const builder = new CertificatePathBuilder(pool);

            await builder.build(leaf);
            await expect(builder.build(leaf)).resolves.toEqual([leaf, ca]);
        });
    });
});
