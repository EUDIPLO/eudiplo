import crypto from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { coseKeyToJwkClaim } from "@owf/cose";
import { hex } from "@owf/identity-common";
import { CoseKey, type MdocContext } from "@owf/mdoc";
import * as x509 from "@peculiar/x509";
import { X509Certificate } from "@peculiar/x509";
import { exportJWK, importX509 } from "jose";
import { toBuffer } from "../src/shared/utils/buffer.util.js";

export const DEVICE_JWK = {
    kty: "EC",
    x: "iBh5ynojixm_D0wfjADpouGbp6b3Pq6SuFHU3htQhVk",
    y: "oxS1OAORJ7XNUHNfVFGeM8E0RQVFxWA62fJj-sxW03c",
    crv: "P-256",
    d: "eRpAZr3eV5xMMnPG3kWjg90Y-bBff9LqmlQuk49HUtA",
};

const privateKeyOf = (key: CoseKey): Uint8Array => {
    if (!key.d) throw new Error("COSE key has no private key (d)");
    return key.d;
};

export const mdocContext: MdocContext = {
    fetch,
    crypto: {
        digest: async ({ digestAlgorithm, bytes }) => {
            const digest = await crypto.subtle.digest(
                digestAlgorithm,
                toBuffer(bytes),
            );
            return new Uint8Array(digest);
        },
        random: (length: number) => {
            return crypto.getRandomValues(new Uint8Array(length));
        },
    },

    cose: {
        sign1: {
            sign: async (input) => {
                const { key, toBeSigned } = input;
                return p256.sign(toBeSigned, privateKeyOf(key), {
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
        getIssuerNameField: (input: {
            certificate: Uint8Array;
            field: string;
        }) => {
            const certificate = new X509Certificate(
                toBuffer(input.certificate),
            );
            return certificate.issuerName.getField(input.field);
        },
        getPublicKey: async (input: {
            certificate: Uint8Array;
            algorithm?: Parameters<typeof coseKeyToJwkClaim.algorithm>[0];
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
            const { trustedCertificates, x5chain: certificateChain } = input;
            if (certificateChain.length === 0)
                throw new Error("Certificate chain is empty");

            const parsedLeafCertificate = new x509.X509Certificate(
                toBuffer(certificateChain[0]),
            );

            const parsedCertificates = certificateChain.map(
                (c) => new x509.X509Certificate(toBuffer(c)),
            );

            const certificateChainBuilder = new x509.X509ChainBuilder({
                certificates: parsedCertificates,
            });

            const chain = await certificateChainBuilder.build(
                parsedLeafCertificate,
            );

            // The chain is reversed here as the `x5c` header (the expected input),
            // has the leaf certificate as the first entry, while the `x509` library expects this as the last
            let parsedChain = chain
                .map((c) => new x509.X509Certificate(c.rawData))
                .reverse();

            if (parsedChain.length !== certificateChain.length) {
                throw new Error(
                    "Could not parse the full chain. Likely due to incorrect ordering",
                );
            }

            const parsedTrustedCertificates = trustedCertificates.map(
                (trustedCertificate) =>
                    new x509.X509Certificate(toBuffer(trustedCertificate)),
            );

            const trustedCertificateIndex = parsedChain.findIndex((cert) =>
                parsedTrustedCertificates.some((tCert) => cert.equal(tCert)),
            );

            if (trustedCertificateIndex === -1) {
                throw new Error(
                    "No trusted certificate was found while validating the X.509 chain",
                );
            }

            // Pop everything off above the index of the trusted as it is not relevant for validation
            parsedChain = parsedChain.slice(0, trustedCertificateIndex);

            // Verify the certificate with the publicKey of the certificate above
            for (let i = 0; i < parsedChain.length; i++) {
                const cert = parsedChain[i];
                const previousCertificate = parsedChain[i - 1];
                const publicKey = previousCertificate
                    ? previousCertificate.publicKey
                    : undefined;
                await cert?.verify({
                    publicKey,
                    date: input.now ?? new Date(),
                });
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
