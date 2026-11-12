import {
    CoseInvalidAlgorithmError,
    cborEncode,
    Sign1,
    SignatureAlgorithm,
} from "@owf/cose";
import { CoseKey } from "@owf/mdoc";
import * as x509 from "@peculiar/x509";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    chainBelow,
    chainCa,
} from "../../../test/trust/certificate-chain.fixture.js";
import { coseReadyJwk } from "../../shared/utils/cose-key-jwk.util.js";
import { mdocContext } from "./mdoc-context.js";

type Alg = "ES256" | "ES384" | "ES512";

const hashOf = (alg: Alg) => `SHA-${alg.slice(2)}`;

async function keysFor(alg: Alg) {
    const { privateKey, publicKey } = await generateKeyPair(alg, {
        extractable: true,
    });
    const toCoseKey = async (key: CryptoKey) =>
        CoseKey.fromJwk(
            coseReadyJwk((await exportJWK(key)) as Record<string, unknown>),
        );
    return {
        privateKey: privateKey as CryptoKey,
        publicKey: publicKey as CryptoKey,
        signingKey: await toCoseKey(privateKey as CryptoKey),
        verificationKey: await toCoseKey(publicKey as CryptoKey),
    };
}

/**
 * A Sig_structure with any `alg`, signed with WebCrypto: @owf/cose refuses to
 * sign with fully-specified or mismatching identifiers itself.
 */
async function signedSigStructure(
    alg: Alg,
    privateKey: CryptoKey,
    protectedHeaders: Map<number, unknown>,
) {
    const toBeVerified = Sign1.create({
        protectedHeaders,
        payload: new TextEncoder().encode("payload"),
    }).toBeSigned();
    const signature = new Uint8Array(
        await globalThis.crypto.subtle.sign(
            { name: "ECDSA", hash: hashOf(alg) },
            privateKey,
            toBeVerified as BufferSource,
        ),
    );
    return { toBeVerified, signature };
}

describe("mdocContext COSE_Sign1", () => {
    it.each([
        ["ES256", 64],
        ["ES384", 96],
        ["ES512", 132],
    ] as const)("signs and verifies with %s keys", async (alg, length) => {
        const { publicKey, signingKey, verificationKey } = await keysFor(alg);
        const sign1 = await Sign1.create({
            protectedHeaders: new Map([[1, SignatureAlgorithm[alg]]]),
            payload: new TextEncoder().encode("payload"),
        }).sign(
            { signingKey, algorithm: SignatureAlgorithm[alg] },
            mdocContext.cose.sign1,
        );

        expect(sign1.signature).toHaveLength(length);
        // Independent check that the hash fits the curve (SHA-384 for P-384, …).
        await expect(
            globalThis.crypto.subtle.verify(
                { name: "ECDSA", hash: hashOf(alg) },
                publicKey,
                sign1.signature as BufferSource,
                sign1.toBeSigned() as BufferSource,
            ),
        ).resolves.toBe(true);
        await expect(
            sign1.verifySignature(
                { key: verificationKey },
                mdocContext.cose.sign1,
            ),
        ).resolves.toBe(true);
    });

    it.each([
        ["ES256", -9],
        ["ES384", -51],
        ["ES512", -52],
    ] as const)(
        "verifies %s with the fully-specified alg %i",
        async (alg, coseAlg) => {
            const { privateKey, verificationKey } = await keysFor(alg);
            const { toBeVerified, signature } = await signedSigStructure(
                alg,
                privateKey,
                new Map([[1, coseAlg]]),
            );

            await expect(
                mdocContext.cose.sign1.verify({
                    key: verificationKey,
                    signature,
                    toBeVerified,
                }),
            ).resolves.toBe(true);
        },
    );

    it.each([
        // header names a different curve than the key
        ["ES384", -7, "ES256"],
        ["ES256", -35, "ES384"],
        ["ES256", -51, "ES384"],
        ["ES512", -9, "ES256"],
    ] as const)(
        "rejects a %s key under alg %i",
        async (keyAlg, coseAlg, headerAlg) => {
            const { privateKey, verificationKey } = await keysFor(keyAlg);
            // Signed with the key's own hash: without the alg check the
            // signature would verify.
            const { toBeVerified, signature } = await signedSigStructure(
                keyAlg,
                privateKey,
                new Map([[1, coseAlg]]),
            );

            await expect(
                mdocContext.cose.sign1.verify({
                    key: verificationKey,
                    signature,
                    toBeVerified,
                }),
            ).rejects.toThrow(
                `COSE_Sign1 alg ${coseAlg} (${headerAlg}) does not match`,
            );
        },
    );

    it("leaves a fully-specified IssuerAuth alg unverifiable, as issuerauth_alg_values says", async () => {
        // @owf/cose refuses alg values outside its classic enum before
        // EUDIPLO's check runs; if that changes, issuerauth_alg_values in
        // OID4VP requests may list -9, -51 and -52 as well.
        const { privateKey, verificationKey } = await keysFor("ES256");
        const { signature } = await signedSigStructure(
            "ES256",
            privateKey,
            new Map([[1, -9]]),
        );
        const sign1 = Sign1.create({
            protectedHeaders: new Map([[1, -9]]),
            payload: new TextEncoder().encode("payload"),
            signature,
        });

        await expect(
            sign1.verifySignature(
                { key: verificationKey },
                mdocContext.cose.sign1,
            ),
        ).rejects.toThrow(CoseInvalidAlgorithmError);
    });

    it("rejects a COSE_Sign1 without alg", async () => {
        const { privateKey, verificationKey } = await keysFor("ES256");
        const { toBeVerified, signature } = await signedSigStructure(
            "ES256",
            privateKey,
            new Map(),
        );

        await expect(
            mdocContext.cose.sign1.verify({
                key: verificationKey,
                signature,
                toBeVerified,
            }),
        ).rejects.toThrow(/no alg in its protected header/);
    });

    it("rejects an alg other than ES256, ES384 or ES512", async () => {
        const { privateKey, verificationKey } = await keysFor("ES256");
        const { toBeVerified, signature } = await signedSigStructure(
            "ES256",
            privateKey,
            new Map([[1, -8]]),
        );

        await expect(
            mdocContext.cose.sign1.verify({
                key: verificationKey,
                signature,
                toBeVerified,
            }),
        ).rejects.toThrow(/Unsupported COSE_Sign1 alg -8/);
    });

    it("rejects bytes that are not a Sig_structure", async () => {
        const { verificationKey } = await keysFor("ES256");

        await expect(
            mdocContext.cose.sign1.verify({
                key: verificationKey,
                signature: new Uint8Array(64),
                toBeVerified: new TextEncoder().encode("to be signed"),
            }),
        ).rejects.toThrow(/Signature1 Sig_structure/);
    });

    it("rejects a Sig_structure other than Signature1", async () => {
        const { verificationKey } = await keysFor("ES256");

        await expect(
            mdocContext.cose.sign1.verify({
                key: verificationKey,
                signature: new Uint8Array(64),
                toBeVerified: cborEncode([
                    "Signature",
                    new Uint8Array(),
                    new Uint8Array(),
                    new Uint8Array(),
                ]),
            }),
        ).rejects.toThrow(/Signature1 Sig_structure/);
    });

    it("refuses to sign with an alg of another curve", async () => {
        const { signingKey } = await keysFor("ES384");

        await expect(
            mdocContext.cose.sign1.sign({
                key: signingKey,
                toBeSigned: new Uint8Array([1]),
                algorithm: SignatureAlgorithm.ES256,
            }),
        ).rejects.toThrow(/does not match the P-384 key/);
    });
});

describe("mdocContext.x509.verifyCertificateChain", () => {
    const hour = 3_600_000;
    const keyAlgorithm = { name: "ECDSA", namedCurve: "P-256" };
    const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
    let serial = 1;

    type Period = { notBefore: Date; notAfter: Date };
    type Issued = {
        cert: x509.X509Certificate;
        keys: CryptoKeyPair;
        der: Uint8Array;
    };

    /** `hours` either side of now, moved by `offset` hours. */
    const period = (offset = 0, hours = 1): Period => ({
        notBefore: new Date(Date.now() + (offset - hours) * hour),
        notAfter: new Date(Date.now() + (offset + hours) * hour),
    });
    const expired = () => period(-2);
    const notYetValid = () => period(2);

    async function keyPair(): Promise<CryptoKeyPair> {
        return (await crypto.subtle.generateKey(keyAlgorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
    }

    const issued = (cert: x509.X509Certificate, keys: CryptoKeyPair) => ({
        cert,
        keys,
        der: new Uint8Array(cert.rawData),
    });

    async function ca(name: string, validity: Period = period()) {
        const keys = await keyPair();
        const cert = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: String(serial++),
            name: `C=DE, CN=${name}`,
            ...validity,
            signingAlgorithm,
            keys,
            extensions: [
                new x509.BasicConstraintsExtension(true, undefined, true),
            ],
        });
        return issued(cert, keys);
    }

    async function issuedBy(
        parent: Issued,
        name: string,
        validity: Period = period(),
    ) {
        const keys = await keyPair();
        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: String(serial++),
            subject: `C=DE, CN=${name}`,
            issuer: parent.cert.subject,
            ...validity,
            signingAlgorithm,
            publicKey: keys.publicKey,
            signingKey: parent.keys.privateKey,
        });
        return issued(cert, keys);
    }

    /** The leaf presented in an x5chain, validated against `anchor`. */
    const verifyChain = (leaf: Issued, anchor: Issued, now?: Date) =>
        mdocContext.x509.verifyCertificateChain({
            trustedCertificates: [anchor.der],
            x5chain: [leaf.der],
            now,
        });

    beforeAll(() => {
        x509.cryptoProvider.set(crypto);
    });

    it("accepts a valid document signer under a valid IACA, leaf first", async () => {
        const iaca = await ca("IACA");
        const documentSigner = await issuedBy(iaca, "Document Signer");

        const { chain } = await verifyChain(documentSigner, iaca);

        expect(chain).toEqual([documentSigner.der, iaca.der]);
    });

    /**
     * The check knows no roles: a status list signer and the status anchor
     * it is validated against are checked as a document signer and its IACA
     * are. `mdocverifier.status-list.spec.ts` covers them through the
     * verifier. The index is the position in the path, anchor first.
     */
    describe.each([
        [
            "document signer",
            1,
            async (validity: Period) => {
                const iaca = await ca("IACA");
                return [
                    await issuedBy(iaca, "Document Signer", validity),
                    iaca,
                ];
            },
        ],
        [
            "IACA",
            0,
            async (validity: Period) => {
                const iaca = await ca("IACA", validity);
                return [await issuedBy(iaca, "Document Signer"), iaca];
            },
        ],
    ])("with an invalid %s", (_role, index, chainWith) => {
        it.each([
            ["has expired", expired],
            ["is not yet valid", notYetValid],
        ])("rejects it when it %s", async (reason, validity) => {
            const [leaf, anchor] = await chainWith(validity());

            await expect(verifyChain(leaf, anchor)).rejects.toThrow(
                new RegExp(
                    `index=${index}\\..*cause=Certificate ${reason}: notBefore=`,
                ),
            );
        });
    });

    it("checks the validity period at the given time, both ends included", async () => {
        // The IACA's period contains the document signer's, so only the
        // document signer decides.
        const iaca = await ca("IACA", period(0, 2));
        const documentSigner = await issuedBy(iaca, "Document Signer");
        const { notBefore, notAfter } = documentSigner.cert;
        const second = 1000;

        for (const now of [notBefore, notAfter]) {
            await expect(
                verifyChain(documentSigner, iaca, now),
            ).resolves.toEqual({ chain: [documentSigner.der, iaca.der] });
        }
        await expect(
            verifyChain(
                documentSigner,
                iaca,
                new Date(notAfter.getTime() + second),
            ),
        ).rejects.toThrow(/index=1\..*cause=Certificate has expired/);
        await expect(
            verifyChain(
                documentSigner,
                iaca,
                new Date(notBefore.getTime() - second),
            ),
        ).rejects.toThrow(/index=1\..*cause=Certificate is not yet valid/);
    });

    it("rejects a document signer that names a trusted IACA but is signed by another key", async () => {
        const iaca = await ca("IACA");
        const impostor = await ca("IACA");
        const forged = await issuedBy(impostor, "Document Signer");

        await expect(verifyChain(forged, iaca)).rejects.toThrow(
            /No trusted certificate was found/,
        );
    });

    it("rejects a certificate whose signature check throws, even without a message", async () => {
        const iaca = await ca("IACA");
        const documentSigner = await issuedBy(iaca, "Document Signer");
        const verify = x509.X509Certificate.prototype.verify;
        // The path builder verifies with a CryptoKey; the chain check with
        // the issuer's PublicKey, which is the call that throws here.
        const spy = vi
            .spyOn(x509.X509Certificate.prototype, "verify")
            .mockImplementation(function (
                this: x509.X509Certificate,
                ...args: Parameters<typeof verify>
            ) {
                if (args[0]?.publicKey instanceof x509.PublicKey) {
                    return Promise.reject(new Error(""));
                }
                return verify.apply(this, args);
            });

        try {
            await expect(verifyChain(documentSigner, iaca)).rejects.toThrow(
                /index=1\..*cause=Certificate signature could not be verified: Error$/,
            );
        } finally {
            spy.mockRestore();
        }
    });

    it("rejects a certificate whose signature does not verify", async () => {
        // @owf/mdoc always passes trust anchors, and the path builder links
        // only certificates whose signature verifies. Without anchors the
        // path starts at the presented certificate, which must then verify
        // under its own key: the one way to reach a `false` signature result.
        const keys = await keyPair();
        const otherKeys = await keyPair();
        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: String(serial++),
            subject: "C=DE, CN=Not Self-signed",
            issuer: "C=DE, CN=Not Self-signed",
            ...period(),
            signingAlgorithm,
            publicKey: keys.publicKey,
            signingKey: otherKeys.privateKey,
        });

        await expect(
            mdocContext.x509.verifyCertificateChain({
                trustedCertificates: undefined as never,
                x5chain: [new Uint8Array(cert.rawData)],
            }),
        ).rejects.toThrow(/cause=Certificate signature is invalid/);
    });
});

// The chain builder's work grows with the square of the chain's length. The
// wallet decides how long an issuer's x5chain is, the issuer's status list
// host how long a status list's is.
describe("mdocContext.x509.verifyCertificateChain x5chain length limit", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const der = (cert: x509.X509Certificate) => new Uint8Array(cert.rawData);

    it("accepts an x5chain of ten certificates", async () => {
        const ca = await chainCa();
        const { chain } = await chainBelow(ca, 10);

        await expect(
            mdocContext.x509.verifyCertificateChain({
                trustedCertificates: [der(ca.cert)],
                x5chain: chain.map(der),
            }),
        ).resolves.toMatchObject({ chain: expect.any(Array) });
    });

    it("refuses an x5chain of eleven certificates before parsing them", async () => {
        const build = vi.spyOn(x509.X509ChainBuilder.prototype, "build");

        await expect(
            mdocContext.x509.verifyCertificateChain({
                trustedCertificates: [new Uint8Array([1])],
                x5chain: new Array(11).fill(new Uint8Array([1])),
            }),
        ).rejects.toThrow(
            "x5chain holds 11 certificates; at most 10 are accepted",
        );
        expect(build).not.toHaveBeenCalled();
    });
});
