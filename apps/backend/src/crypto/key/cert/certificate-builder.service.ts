import { Injectable } from "@nestjs/common";
import { id_ce_issuerAltName } from "@peculiar/asn1-x509";
import * as x509 from "@peculiar/x509";
import type { JWK } from "jose";
import { signingAlgForJwk, signingAlgSpec } from "../domain/signing-algs.js";
import {
    documentSignerSubject,
    MDL_DOCUMENT_SIGNER_EKU,
    type SigningCertificateProfile,
} from "../domain/signing-certificate-profile.js";
import type {
    KmsAdapter,
    KmsKeyRef,
    KmsSigningAlg,
} from "../kms/kms-adapter.js";
import {
    importPublicCryptoKey,
    makeKmsSigningKey,
} from "../kms/kms-crypto-provider.js";

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
 *
 * All keys are EC signing keys, so key usages never include
 * keyEncipherment (RFC 5480 3; ISO/IEC 18013-5 expects digitalSignature
 * alone for document signer certificates).
 *
 * Generated root CAs follow the ISO/IEC 18013-5 Annex B.1.2 IACA profile
 * for every usage type, and signing certificates the B.1.4 document signer
 * profile where {@link signingCertificateProfile} says so. Neither carries
 * a CRLDistributionPoints extension: EUDIPLO publishes no CRL for the CAs
 * it creates, and a distribution point that serves none would make
 * verifiers that fetch it fail.
 *
 * `publicUrl` is EUDIPLO's `PUBLIC_URL`: its host becomes the dNSName of
 * the SubjectAlternativeName, the URL itself the IssuerAlternativeName.
 */
@Injectable()
export class CertificateBuilderService {
    /**
     * A self-signed root CA in the IACA profile (ISO/IEC 18013-5 Annex
     * B.1.2): random serial number, key usage keyCertSign and cRLSign only,
     * CA=true with pathLenConstraint 0 (it signs the leaves directly), and
     * an IssuerAlternativeName.
     */
    async createSelfSignedCaCert(
        adapter: KmsAdapter,
        ref: KmsKeyRef,
        subjectCN: string,
        publicUrl: string,
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
                subjectAltName(publicUrl),
                issuerAltName(publicUrl),
                new x509.BasicConstraintsExtension(true, 0, true),
                new x509.KeyUsagesExtension(
                    x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
                    true,
                ),
                await x509.SubjectKeyIdentifierExtension.create(publicKey),
            ],
        });
        return cert.toString("pem");
    }

    async createSelfSignedCert(opts: {
        adapter: KmsAdapter;
        ref: KmsKeyRef;
        subjectCN: string;
        publicUrl: string;
        notBefore: Date;
        notAfter: Date;
        profile: SigningCertificateProfile;
    }): Promise<string> {
        const { adapter, ref, subjectCN, publicUrl, notBefore, notAfter } =
            opts;
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
                subjectAltName(publicUrl),
                new x509.BasicConstraintsExtension(false, undefined, true),
                new x509.KeyUsagesExtension(
                    x509.KeyUsageFlags.digitalSignature,
                    true,
                ),
                await x509.SubjectKeyIdentifierExtension.create(publicKey),
                ...(opts.profile === "documentSigner"
                    ? documentSignerExtensions(issuerAltName(publicUrl))
                    : []),
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
        publicUrl: string;
        notBefore: Date;
        notAfter: Date;
        profile: SigningCertificateProfile;
        /** Defaults to the algorithm of the subject key's curve. */
        subjectAlg?: KmsSigningAlg;
    }): Promise<{ cert: string; chain: string[] }> {
        const {
            caAdapter,
            caRef,
            caCertPem,
            subjectPublicJwk,
            subjectCN,
            publicUrl,
            notBefore,
            notAfter,
            profile,
            subjectAlg = signingAlgForJwk(opts.subjectPublicJwk),
        } = opts;
        const caCert = new x509.X509Certificate(caCertPem);
        // The parsed Name, not the `subject` string: re-encoding the string
        // turns e.g. a UTF8String CN into a PrintableString, and validators
        // that compare issuer and subject bytes (Go crypto/x509) then no longer
        // link the leaf to its CA. RFC 5280 4.1.2.6 and 8 require the issuer
        // to be encoded exactly like the CA's subject.
        const issuerName = caCert.subjectName;

        const caPublicKey = await importPublicCryptoKey(
            caRef.publicJwk,
            caRef.alg,
        );
        const subjectPublicKey = await importPublicCryptoKey(
            subjectPublicJwk,
            subjectAlg,
        );
        const signingKey = makeKmsSigningKey(caAdapter, caRef, caRef.alg);
        // RFC 5280 4.2.1.2: the AKI carries the CA's own SKI. An imported CA
        // may derive it differently (RFC 7093, random), so copy it; compute
        // it from the key only when the CA certificate has none.
        const caKeyId = caCert.getExtension(
            x509.SubjectKeyIdentifierExtension,
        )?.keyId;
        const authorityKeyIdentifier = caKeyId
            ? new x509.AuthorityKeyIdentifierExtension(caKeyId)
            : await x509.AuthorityKeyIdentifierExtension.create(caPublicKey);

        const cert = await x509.X509CertificateGenerator.create({
            serialNumber: this.generateSerialNumber(),
            subject:
                profile === "documentSigner"
                    ? documentSignerSubject(caCert.subjectName, subjectCN)
                    : `C=DE, CN=${subjectCN}`,
            issuer: issuerName,
            notBefore,
            notAfter,
            signingAlgorithm: signatureAlgFor(caRef.alg),
            publicKey: subjectPublicKey,
            signingKey,
            extensions: [
                subjectAltName(publicUrl),
                new x509.BasicConstraintsExtension(false, undefined, true),
                new x509.KeyUsagesExtension(
                    x509.KeyUsageFlags.digitalSignature,
                    true,
                ),
                await x509.SubjectKeyIdentifierExtension.create(
                    subjectPublicKey,
                ),
                authorityKeyIdentifier,
                ...(profile === "documentSigner"
                    ? documentSignerExtensions(
                          caIssuerAltName(caCert) ?? issuerAltName(publicUrl),
                      )
                    : []),
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

/** X.509 signature algorithm (ecdsa-with-SHAxxx) for a signing key's algorithm. */
function signatureAlgFor(alg: KmsSigningAlg): EcdsaParams {
    return { name: "ECDSA", hash: signingAlgSpec(alg).hash };
}

/** dNSName of the host of `PUBLIC_URL`. */
function subjectAltName(publicUrl: string): x509.Extension {
    return new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: new URL(publicUrl).hostname },
    ]);
}

/**
 * IssuerAlternativeName with `PUBLIC_URL` as uniformResourceIdentifier.
 * ISO/IEC 18013-5 Annex B requires it, non-critical, with an e-mail
 * address or a URL of the issuing authority, in the IACA and the document
 * signer certificate.
 */
function issuerAltName(publicUrl: string): x509.Extension {
    // Written as configured; subjectAltName has already parsed it.
    return new x509.IssuerAlternativeNameExtension(
        [{ type: "url", value: publicUrl }],
        false,
    );
}

/**
 * The CA certificate's IssuerAlternativeName, byte for byte and
 * non-critical, so a document signer under an imported IACA names the same
 * issuing authority. Undefined when the CA has none, or when its value is
 * not a GeneralNames structure, as in some reference IACAs that wrap a
 * nested Extension: the document signer then names `PUBLIC_URL` rather
 * than pass on an extension strict verifiers cannot parse.
 */
function caIssuerAltName(
    caCert: x509.X509Certificate,
): x509.Extension | undefined {
    const ian = caCert.extensions.find((e) => e.type === id_ce_issuerAltName);
    if (!ian) return undefined;
    try {
        new x509.GeneralNames(ian.value);
    } catch {
        return undefined;
    }
    return new x509.Extension(id_ce_issuerAltName, false, ian.value);
}

/**
 * Extensions the document signer profile adds (ISO/IEC 18013-5 Annex
 * B.1.4): the critical mDL document signer extended key usage and the
 * IssuerAlternativeName.
 */
function documentSignerExtensions(
    issuerAltNameExtension: x509.Extension,
): x509.Extension[] {
    return [
        new x509.ExtendedKeyUsageExtension([MDL_DOCUMENT_SIGNER_EKU], true),
        issuerAltNameExtension,
    ];
}
