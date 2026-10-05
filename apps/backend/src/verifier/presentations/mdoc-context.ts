import { timingSafeEqual } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { coseKeyToJwkClaim } from "@owf/cose";
import { hex } from "@owf/identity-common";
import { CoseKey, type MdocContext } from "@owf/mdoc";
import { hkdf } from "@panva/hkdf";
import * as x509 from "@peculiar/x509";
import { X509Certificate } from "@peculiar/x509";
import { exportJWK, importX509 } from "jose";
import { toBuffer } from "../../shared/utils/buffer.util.js";

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

const verifyChainSignatures = async (
    parsedChain: X509Certificate[],
    trustedCertificates: Uint8Array[] | undefined,
    now: Date | undefined,
    startingPreviousCertificate: X509Certificate | undefined,
) => {
    let previousCertificate = startingPreviousCertificate;

    for (let i = 0; i < parsedChain.length; i++) {
        const cert = parsedChain[i];
        const publicKey = previousCertificate?.publicKey;

        const skipSignatureVerification =
            i === 0 && Boolean(trustedCertificates) && !publicKey;

        if (!skipSignatureVerification) {
            try {
                await cert.verify({
                    publicKey,
                    date: now ?? new Date(),
                });
            } catch (error: any) {
                const [currentCert, previousCert, links] = await Promise.all([
                    certificateIdentifiers(cert),
                    previousCertificate
                        ? certificateIdentifiers(previousCertificate)
                        : Promise.resolve(undefined),
                    chainLinkDiagnostics(parsedChain),
                ]);

                throw new Error(
                    `X.509 chain verification failed at index=${i}. current=${JSON.stringify(currentCert)} previous=${JSON.stringify(previousCert)} links=${JSON.stringify(links)} cause=${error?.message ?? error}`,
                );
            }
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
                const { key, toBeSigned } = input;
                return p256.sign(toBeSigned, key.privateKey, {
                    format: "compact",
                });
            },
            verify: async (input) => {
                const { signature, key, toBeVerified } = input;
                // lowS is needed after upgrade of @noble/curves to keep existing tests passing
                return p256.verify(signature, toBeVerified, key.publicKey, {
                    lowS: false,
                });
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
                : "ES256";

            const key = await importX509(certificate.toString(), alg, {
                extractable: true,
            });

            return CoseKey.fromJwk(
                (await exportJWK(key)) as unknown as Record<string, unknown>,
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

            const parsedLeafCertificate = new x509.X509Certificate(
                toBuffer(certificateChain[0]),
            );
            const certificatesToBuildChain = toX509Certificates([
                ...certificateChain,
                ...(trustedCertificates ?? []),
            ]);

            const certificateChainBuilder = new x509.X509ChainBuilder({
                certificates: certificatesToBuildChain,
            });
            const chain = await certificateChainBuilder.build(
                parsedLeafCertificate,
            );

            // x5c is leaf-first, but chain builder returns root-first.
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

            await verifyChainSignatures(
                parsedChain,
                trustedCertificates,
                now,
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

            return {
                chain: parsedChain.map((cert) => new Uint8Array(cert.rawData)),
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
