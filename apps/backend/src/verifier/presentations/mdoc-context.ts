import { timingSafeEqual } from "node:crypto";
import { p256, p384, p521 } from "@noble/curves/nist.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Curve, cborDecode, coseKeyToJwkClaim } from "@owf/cose";
import { hex } from "@owf/identity-common";
import { CoseKey, type MdocContext } from "@owf/mdoc";
import { hkdf } from "@panva/hkdf";
import * as x509 from "@peculiar/x509";
import { X509Certificate } from "@peculiar/x509";
import { exportJWK, importX509 } from "jose";
import {
    type KmsSigningAlg,
    SIGNING_ALG_SPECS,
    signingAlgForCoseAlg,
    signingAlgForCurve,
} from "../../crypto/key/domain/signing-algs.js";
import { toBuffer } from "../../shared/utils/buffer.util.js";
import { assertCertificateChainLength } from "../../shared/utils/certificate-chain-length.util.js";
import { CertificatePathBuilder } from "../../shared/utils/certificate-path.util.js";
import {
    certificateValidityAt,
    formatCertificateDate,
} from "../../shared/utils/certificate-validity.util.js";
import { coseReadyJwk } from "../../shared/utils/cose-key-jwk.util.js";

const NOBLE_CURVES = { ES256: p256, ES384: p384, ES512: p521 } as const;

/** The algorithm bound to a COSE key's curve. Keys without a curve are P-256. */
function signingAlgForKey(key: CoseKey): KmsSigningAlg {
    switch (key.curve ?? Curve["P-256"]) {
        case Curve["P-256"]:
            return "ES256";
        case Curve["P-384"]:
            return "ES384";
        case Curve["P-521"]:
            return "ES512";
        default:
            throw new Error(
                `Unsupported COSE key curve ${String(key.curve)}: expected P-256, P-384 or P-521`,
            );
    }
}

/**
 * The `alg` (label 1) of the protected header inside a COSE Sig_structure
 * `["Signature1", body_protected, external_aad, payload]` (RFC 9052 §4.4).
 * @owf/mdoc does not pass the algorithm when it checks a DeviceSignature,
 * so the signed bytes are the one place that always carries it.
 */
function protectedAlgOf(toBeVerified: Uint8Array): unknown {
    let protectedHeaders: unknown;
    let cause: unknown;
    try {
        const sigStructure = cborDecode(toBeVerified);
        if (
            Array.isArray(sigStructure) &&
            sigStructure[0] === "Signature1" &&
            sigStructure[1] instanceof Uint8Array
        ) {
            protectedHeaders =
                sigStructure[1].length === 0
                    ? new Map()
                    : cborDecode(sigStructure[1]);
        }
    } catch (error) {
        cause = error;
    }
    if (!(protectedHeaders instanceof Map)) {
        throw new TypeError(
            "COSE_Sign1 verification expects a Signature1 Sig_structure with a protected header map",
            { cause },
        );
    }
    return protectedHeaders.get(1);
}

/**
 * The algorithm a COSE_Sign1 is signed or verified with, from its `alg`
 * header: classic (-7, -35, -36) or fully specified (-9, -51, -52). The
 * hash follows from the `alg` and must fit the curve of the key. RFC 9864
 * defines the fully specified ids that way; for the classic ones RFC 9053
 * §2.1 only recommends the pairing, and EUDIPLO enforces it as it does for
 * JOSE (RFC 7518 §3.4), so a header never selects a hash weaker than the key.
 */
function algForCoseAlgAndKey(coseAlg: unknown, key: CoseKey): KmsSigningAlg {
    if (coseAlg === undefined) {
        throw new Error("COSE_Sign1 has no alg in its protected header");
    }
    const alg = signingAlgForCoseAlg(coseAlg);
    if (!alg) {
        const shown =
            typeof coseAlg === "number" || typeof coseAlg === "string"
                ? String(coseAlg)
                : `of type ${typeof coseAlg}`;
        throw new Error(
            `Unsupported COSE_Sign1 alg ${shown}: expected one of ES256 (-7, -9), ES384 (-35, -51), ES512 (-36, -52)`,
        );
    }
    const keyAlg = signingAlgForKey(key);
    if (keyAlg !== alg) {
        throw new Error(
            `COSE_Sign1 alg ${coseAlg as number} (${alg}) does not match the ${SIGNING_ALG_SPECS[keyAlg].crv} key, which requires ${keyAlg}`,
        );
    }
    return alg;
}

// Use global Web Crypto API (available in Node.js 19+)
const webCrypto = globalThis.crypto;
const configuredLogLevel = (
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "production" ? "warn" : "debug")
).toLowerCase();
const X509_CHAIN_TRACE = configuredLogLevel === "trace";
const X509_CHAIN_DEBUG = X509_CHAIN_TRACE || configuredLogLevel === "debug";

const extractExtensionKeyId = (
    extension: { keyId?: string } | undefined,
): string | undefined => {
    const keyId = extension?.keyId;
    return typeof keyId === "string" && keyId.length > 0
        ? keyId.toLowerCase()
        : undefined;
};

const certificateIdentifiers = async (cert: X509Certificate) => {
    const thumbprint = hex.encode(
        new Uint8Array(await cert.getThumbprint("SHA-256")),
    );

    return {
        subject: cert.subject,
        issuer: cert.issuer,
        thumbprint,
        ski: extractExtensionKeyId(cert.getExtension("2.5.29.14") as any),
        aki: extractExtensionKeyId(cert.getExtension("2.5.29.35") as any),
    };
};

const chainLinkDiagnostics = async (chain: X509Certificate[]) => {
    const links = [] as Array<{
        childIndex: number;
        parentIndex: number;
        childSubject: string;
        childAki?: string;
        parentSubject: string;
        parentSki?: string;
        keyIdMatches: boolean;
        issuerSubjectMatches: boolean;
    }>;

    for (let i = 0; i < chain.length - 1; i++) {
        const child = chain[i];
        const parent = chain[i + 1];
        const childAki = extractExtensionKeyId(
            child.getExtension("2.5.29.35") as any,
        );
        const parentSki = extractExtensionKeyId(
            parent.getExtension("2.5.29.14") as any,
        );

        links.push({
            childIndex: i,
            parentIndex: i + 1,
            childSubject: child.subject,
            childAki,
            parentSubject: parent.subject,
            parentSki,
            keyIdMatches:
                childAki !== undefined &&
                parentSki !== undefined &&
                childAki === parentSki,
            issuerSubjectMatches: child.issuer === parent.subject,
        });
    }

    return links;
};

const toX509Certificates = (certificates: Uint8Array[]) =>
    certificates.map(
        (certificate) => new x509.X509Certificate(toBuffer(certificate)),
    );

const trimChainToTrustedAnchor = async (
    parsedChain: X509Certificate[],
    trustedCertificates: Uint8Array[] | undefined,
): Promise<{
    parsedChain: X509Certificate[];
    previousCertificate: X509Certificate | undefined;
}> => {
    if (!trustedCertificates) {
        return {
            parsedChain,
            previousCertificate: undefined,
        };
    }

    const parsedTrustedCertificates = trustedCertificates.map(
        (trustedCertificate) =>
            new X509Certificate(toBuffer(trustedCertificate)),
    );

    const trustedCertificateIndex = parsedChain.findIndex((cert) =>
        parsedTrustedCertificates.some((trustedCert) =>
            cert.equal(trustedCert),
        ),
    );

    if (trustedCertificateIndex === -1) {
        if (X509_CHAIN_DEBUG) {
            const [chainDiagnostics, trustedDiagnostics] = await Promise.all([
                Promise.all(
                    parsedChain.map((cert) => certificateIdentifiers(cert)),
                ),
                Promise.all(
                    parsedTrustedCertificates.map((cert) =>
                        certificateIdentifiers(cert),
                    ),
                ),
            ]);
            throw new Error(
                `No trusted certificate was found while validating the X.509 chain. chain=${JSON.stringify(chainDiagnostics)} trusted=${JSON.stringify(trustedDiagnostics)}`,
            );
        }

        throw new Error(
            "No trusted certificate was found while validating the X.509 chain",
        );
    }

    if (trustedCertificateIndex > 0) {
        return {
            parsedChain: parsedChain.slice(trustedCertificateIndex),
            previousCertificate: parsedChain[trustedCertificateIndex - 1],
        };
    }

    return {
        parsedChain,
        previousCertificate: undefined,
    };
};

/**
 * Matches the cause that {@link mdocContext}'s `verifyCertificateChain`
 * gives for a certificate outside its validity period. @owf/mdoc passes on
 * only the message, so callers classify the failure by it. Anchored to the
 * `cause=` and the period that follows: Node.js reports an expired TLS
 * certificate, as when a status list cannot be fetched, with the same words.
 */
export const CERTIFICATE_VALIDITY_FAILURE =
    /cause=certificate (?:has expired|is not yet valid): notbefore=/i;

/**
 * Why `cert` is not valid at `now`, or undefined if it is, by the rule the
 * SD-JWT VC chain check uses too ({@link certificateValidityAt}). Checked
 * here rather than with @peculiar/x509's `verify({ date })`, which excludes
 * both ends of the period and reports a date outside it only as `false`.
 */
const validityPeriodFailure = (
    cert: X509Certificate,
    now: Date,
): string | undefined => {
    const validity = certificateValidityAt(cert, now);
    if (validity === "valid") {
        return undefined;
    }
    const period = `notBefore=${formatCertificateDate(cert.notBefore)} notAfter=${formatCertificateDate(cert.notAfter)} checkedAt=${formatCertificateDate(now)}`;
    return validity === "expired"
        ? `Certificate has expired: ${period}`
        : `Certificate is not yet valid: ${period}`;
};

/**
 * Check every certificate of a root-first path: its signature against the
 * key of the certificate before it, and its validity period against `now`.
 * The trusted anchor at the start is not signature-checked, but its validity
 * period is. @peculiar/x509 reports an invalid signature as `false`, not as
 * an exception, so the result is checked as well.
 */
const verifyChainCertificates = async (
    parsedChain: X509Certificate[],
    trustedCertificates: Uint8Array[] | undefined,
    now: Date,
    startingPreviousCertificate: X509Certificate | undefined,
) => {
    let previousCertificate = startingPreviousCertificate;

    for (let i = 0; i < parsedChain.length; i++) {
        const cert = parsedChain[i];
        const publicKey = previousCertificate?.publicKey;

        const skipSignatureVerification =
            i === 0 && Boolean(trustedCertificates) && !publicKey;

        let cause: string | undefined;
        try {
            if (
                !skipSignatureVerification &&
                !(await cert.verify({ publicKey, signatureOnly: true }))
            ) {
                cause = "Certificate signature is invalid";
            }
        } catch (error: any) {
            // Never empty, so that the check below cannot pass it.
            cause = `Certificate signature could not be verified: ${error?.message || String(error)}`;
        }
        cause ??= validityPeriodFailure(cert, now);

        if (cause) {
            const [currentCert, previousCert, links] = await Promise.all([
                certificateIdentifiers(cert),
                previousCertificate
                    ? certificateIdentifiers(previousCertificate)
                    : Promise.resolve(undefined),
                chainLinkDiagnostics(parsedChain),
            ]);

            throw new Error(
                `X.509 chain verification failed at index=${i}. current=${JSON.stringify(currentCert)} previous=${JSON.stringify(previousCert)} links=${JSON.stringify(links)} cause=${cause}`,
            );
        }

        previousCertificate = cert;
    }
};

/**
 * Everything @owf/mdoc needs except `fetch`, for signing, session transcripts
 * and issuance. Verifying a presented mDOC fetches the status list or
 * identifier list named in its MSO, and has to use {@link withFetch} with a
 * fetch under the outbound URL policy. Without `fetch` here, passing this
 * context to a verification is a type error; at runtime @owf/mdoc would
 * fall back to the global `fetch`.
 *
 * `cose.sign1` binds the COSE `alg` to the key's curve: `sign` needs an
 * `algorithm` that fits the key, and `verify` reads the `alg` from the signed
 * protected header and rejects a missing or mismatching one.
 */
export const mdocContext: Omit<MdocContext, "fetch"> = {
    crypto: {
        digest: async ({ digestAlgorithm, bytes }) => {
            const digest = await webCrypto.subtle.digest(
                digestAlgorithm,
                toBuffer(bytes),
            );
            return new Uint8Array(digest);
        },
        random: (length: number) => {
            return webCrypto.getRandomValues(new Uint8Array(length));
        },
        hdkf: async (input) => {
            const {
                digestAlgorithm: da,
                salt,
                info,
                publicKey,
                privateKey,
            } = input;
            const ikm = p256
                .getSharedSecret(privateKey, publicKey, true)
                .slice(1);
            let digestAlgorithm: "sha256" | "sha384" | "sha512" = "sha256";
            if (da === "SHA-384") {
                digestAlgorithm = "sha384";
            } else if (da === "SHA-512") {
                digestAlgorithm = "sha512";
            }
            return hkdf(digestAlgorithm, ikm, salt, info, 32);
        },
    },

    cose: {
        mac0: {
            authenticate: async (input) => {
                const { key, toBeAuthenticated } = input;
                const keyBytes = key instanceof CoseKey ? key.privateKey : key;
                return hmac(sha256, keyBytes, toBeAuthenticated);
            },
            verify: async (input) => {
                const { tag, toBeAuthenticated, key } = input;
                const keyBytes = key instanceof CoseKey ? key.privateKey : key;
                const expectedTag = hmac(sha256, keyBytes, toBeAuthenticated);
                if (tag.length !== expectedTag.length) {
                    return false;
                }
                return timingSafeEqual(tag, expectedTag);
            },
        },
        sign1: {
            sign: async (input) => {
                const { key, toBeSigned, algorithm } = input;
                const alg = algForCoseAlgAndKey(algorithm, key);
                return NOBLE_CURVES[alg].sign(toBeSigned, key.privateKey, {
                    format: "compact",
                });
            },
            verify: async (input) => {
                const { signature, key, toBeVerified } = input;
                // The signed protected header decides, even where @owf/mdoc
                // passes `algorithm`: for a DeviceSignature it passes none.
                const alg = algForCoseAlgAndKey(
                    protectedAlgOf(toBeVerified),
                    key,
                );
                // lowS is needed after upgrade of @noble/curves to keep existing tests passing
                return NOBLE_CURVES[alg].verify(
                    signature,
                    toBeVerified,
                    key.publicKey,
                    {
                        lowS: false,
                    },
                );
            },
        },
    },

    x509: {
        getSubjectNameField: (input: {
            certificate: Uint8Array;
            field: string;
        }) => {
            const certificate = new X509Certificate(
                toBuffer(input.certificate),
            );
            return certificate.subjectName.getField(input.field);
        },
        getPublicKey: async (input: {
            certificate: Uint8Array;
            algorithm?: NonNullable<
                Parameters<typeof coseKeyToJwkClaim.algorithm>[0]
            >;
        }) => {
            const certificate = new X509Certificate(
                toBuffer(input.certificate),
            );
            const alg = input.algorithm
                ? coseKeyToJwkClaim.algorithm(input.algorithm)
                : (signingAlgForCurve(
                      (certificate.publicKey.algorithm as EcKeyAlgorithm)
                          .namedCurve,
                  ) ?? "ES256");

            const key = await importX509(certificate.toString(), alg, {
                extractable: true,
            });

            return CoseKey.fromJwk(
                coseReadyJwk(
                    (await exportJWK(key)) as unknown as Record<
                        string,
                        unknown
                    >,
                ),
            );
        },

        verifyCertificateChain: async (input: {
            trustedCertificates: Array<Uint8Array>;
            x5chain: Array<Uint8Array>;
            now?: Date;
        }) => {
            const {
                trustedCertificates,
                x5chain: certificateChain,
                now,
            } = input;

            if (certificateChain.length === 0) {
                throw new Error("Certificate chain is empty");
            }
            // The issuer's chain from the wallet, or a status list's chain
            // from the host that serves it.
            assertCertificateChainLength(certificateChain, "x5chain");

            const parsedLeafCertificate = new x509.X509Certificate(
                toBuffer(certificateChain[0]),
            );
            const certificatesToBuildChain = toX509Certificates([
                ...certificateChain,
                ...(trustedCertificates ?? []),
            ]);

            // Within MAX_CERTIFICATE_PATH_LENGTH and
            // MAX_PATH_SIGNATURE_CHECKS, whatever the trust list holds.
            const chain = await new CertificatePathBuilder(
                certificatesToBuildChain,
            ).build(parsedLeafCertificate);

            // The path is leaf-first, like x5chain; the checks below go
            // root-first.
            let parsedChain = chain.reverse();

            if (parsedChain.length < certificateChain.length) {
                throw new Error(
                    "Could not parse the full chain. Likely due to incorrect ordering",
                );
            }

            const trimmed = await trimChainToTrustedAnchor(
                parsedChain,
                trustedCertificates,
            );
            parsedChain = trimmed.parsedChain;

            await verifyChainCertificates(
                parsedChain,
                trustedCertificates,
                now ?? new Date(),
                trimmed.previousCertificate,
            );

            if (X509_CHAIN_TRACE) {
                const [chainDiagnostics, links] = await Promise.all([
                    Promise.all(
                        parsedChain.map((cert) => certificateIdentifiers(cert)),
                    ),
                    chainLinkDiagnostics(parsedChain),
                ]);
                console.debug(
                    "mdocContext.x509.verifyCertificateChain diagnostics",
                    JSON.stringify({ chainDiagnostics, links }),
                );
            }

            // @owf/mdoc expects the validated path leaf first and the trusted
            // anchor last: it takes the status list signers of the trusted
            // entry whose issuance certificate is the last one.
            return {
                chain: [...parsedChain]
                    .reverse()
                    .map((cert) => new Uint8Array(cert.rawData)),
            };
        },
        getCertificateData: async (input: { certificate: Uint8Array }) => {
            const certificate = new X509Certificate(
                toBuffer(input.certificate),
            );
            const thumbprint = await certificate.getThumbprint();
            const thumbprintHex = hex.encode(new Uint8Array(thumbprint));
            return {
                issuerName: certificate.issuerName.toString(),
                subjectName: certificate.subjectName.toString(),
                pem: certificate.toString(),
                serialNumber: certificate.serialNumber,
                thumbprint: thumbprintHex,
                notBefore: certificate.notBefore,
                notAfter: certificate.notAfter,
            };
        },
    },
};

/** {@link mdocContext} with the `fetch` that verifying an mDOC needs. */
export const withFetch = (fetch: MdocContext["fetch"]): MdocContext => ({
    ...mdocContext,
    fetch,
});
