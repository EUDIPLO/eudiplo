import { Injectable } from "@nestjs/common";
import * as x509 from "@peculiar/x509";
import type { JWK } from "jose";
import type {
    KmsAdapter,
    KmsKeyRef,
    KmsSigningAlg,
} from "../kms/kms-adapter.js";
import {
    importPublicCryptoKey,
    makeKmsSigningKey,
} from "../kms/kms-crypto-provider.js";

const ECDSA_P256_SIGNATURE_ALG = {
    name: "ECDSA",
    hash: "SHA-256" as const,
};

/**
 * Start of validity for generated certificates, rounded down to the full hour.
 * Credential timestamps are rounded down to the hour as well, so a certificate
 * starting at the exact creation time would not cover credentials signed within
 * its first hour (ISO 18013-5 requires the MSO signed date to lie within it).
 */
export function certificateNotBefore(now: Date = new Date()): Date {
    const hourMs = 60 * 60 * 1000;
    return new Date(Math.floor(now.getTime() / hourMs) * hourMs);
}

/**
 * Pure X.509 certificate construction. The certificate signature is
 * produced by the KMS adapter, so private key material never leaves
 * the configured backend (DB, Vault Transit, AWS KMS).
 *
 * The mechanism: we pass a {@link makeKmsSigningKey} CryptoKey-shaped
 * marker to `@peculiar/x509`. The {@link KmsCryptoProvider} (installed
 * globally on `x509.cryptoProvider`) intercepts `subtle.sign(...)` for
 * those keys and routes the call to {@link KmsAdapter.sign}.
 */
@Injectable()
export class CertificateBuilderService {
    async createSelfSignedCaCert(
        adapter: KmsAdapter,
        ref: KmsKeyRef,
        subjectCN: string,
        hostname: string,
        notBefore: Date,
        notAfter: Date,
    ): Promise<string> {
        const publicKey = await importPublicCryptoKey(ref.publicJwk, ref.alg);
        const signingKey = makeKmsSigningKey(adapter, ref, ref.alg);

        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: "01",
            subject: `C=DE, CN=${subjectCN}`,
            issuer: `C=DE, CN=${subjectCN}`,
            notBefore,
            notAfter,
            signingAlgorithm: signatureAlgFor(ref.alg),
            publicKey,
            signingKey,
            extensions: [
                new x509.SubjectAlternativeNameExtension([
                    { type: "dns", value: hostname },
                ]),
                new x509.BasicConstraintsExtension(true, undefined, true),
                new x509.KeyUsagesExtension(
                    x509.KeyUsageFlags.digitalSignature |
                        x509.KeyUsageFlags.keyEncipherment |
                        x509.KeyUsageFlags.keyCertSign,
                    true,
                ),
                await x509.SubjectKeyIdentifierExtension.create(publicKey),
            ],
        });
        return cert.toString("pem");
    }

    async createSelfSignedCert(
        adapter: KmsAdapter,
        ref: KmsKeyRef,
        subjectCN: string,
        hostname: string,
        notBefore: Date,
        notAfter: Date,
    ): Promise<string> {
        const publicKey = await importPublicCryptoKey(ref.publicJwk, ref.alg);
        const signingKey = makeKmsSigningKey(adapter, ref, ref.alg);

        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: this.generateSerialNumber(),
            subject: `C=DE, CN=${subjectCN}`,
            issuer: `C=DE, CN=${subjectCN}`,
            notBefore,
            notAfter,
            signingAlgorithm: signatureAlgFor(ref.alg),
            publicKey,
            signingKey,
            extensions: [
                new x509.SubjectAlternativeNameExtension([
                    { type: "dns", value: hostname },
                ]),
                new x509.BasicConstraintsExtension(false, undefined, true),
                new x509.KeyUsagesExtension(
                    x509.KeyUsageFlags.digitalSignature |
                        x509.KeyUsageFlags.keyEncipherment,
                    true,
                ),
                await x509.SubjectKeyIdentifierExtension.create(publicKey),
            ],
        });
        return cert.toString("pem");
    }

    async createCaSignedCert(opts: {
        caAdapter: KmsAdapter;
        caRef: KmsKeyRef;
        caCertPem: string;
        subjectPublicJwk: JWK;
        subjectCN: string;
        hostname: string;
        notBefore: Date;
        notAfter: Date;
        subjectAlg?: KmsSigningAlg;
    }): Promise<{ cert: string; chain: string[] }> {
        const {
            caAdapter,
            caRef,
            caCertPem,
            subjectPublicJwk,
            subjectCN,
            hostname,
            notBefore,
            notAfter,
            subjectAlg = "ES256",
        } = opts;
        const caCert = new x509.X509Certificate(caCertPem);
        const issuerName = caCert.subject;

        const caPublicKey = await importPublicCryptoKey(
            caRef.publicJwk,
            caRef.alg,
        );
        const subjectPublicKey = await importPublicCryptoKey(
            subjectPublicJwk,
            subjectAlg,
        );
        const signingKey = makeKmsSigningKey(caAdapter, caRef, caRef.alg);

        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: this.generateSerialNumber(),
            subject: `C=DE, CN=${subjectCN}`,
            issuer: issuerName,
            notBefore,
            notAfter,
            signingAlgorithm: signatureAlgFor(caRef.alg),
            publicKey: subjectPublicKey,
            signingKey,
            extensions: [
                new x509.SubjectAlternativeNameExtension([
                    { type: "dns", value: hostname },
                ]),
                new x509.BasicConstraintsExtension(false, undefined, true),
                new x509.KeyUsagesExtension(
                    x509.KeyUsageFlags.digitalSignature |
                        x509.KeyUsageFlags.keyEncipherment,
                    true,
                ),
                await x509.SubjectKeyIdentifierExtension.create(
                    subjectPublicKey,
                ),
                await x509.AuthorityKeyIdentifierExtension.create(caPublicKey),
            ],
        });

        const certPem = cert.toString("pem");
        return { cert: certPem, chain: [certPem, caCertPem] };
    }

    splitPemChain(pem: string): string[] {
        const certs: string[] = [];
        const parts = pem.split("-----END CERTIFICATE-----");
        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.includes("-----BEGIN CERTIFICATE-----")) {
                certs.push(`${trimmed}\n-----END CERTIFICATE-----`);
            }
        }
        return certs;
    }

    generateSerialNumber(): string {
        const bytes = new Uint8Array(16);
        globalThis.crypto.getRandomValues(bytes);
        return Buffer.from(bytes).toString("hex");
    }
}

function signatureAlgFor(alg: KmsSigningAlg) {
    if (alg === "ES256") {
        return ECDSA_P256_SIGNATURE_ALG;
    }
    const _exhaustive: never = alg;
    throw new Error(`Unsupported signing algorithm: ${String(_exhaustive)}`);
}
