import * as x509 from "@peculiar/x509";

const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";

/**
 * The extensions EUDIPLO accepts when a certificate of a path marks them
 * critical (RFC 5280 section 4.2: a certificate-using system "MUST reject
 * the certificate if it encounters a critical extension it does not
 * recognize or a critical extension that contains information that it
 * cannot process"). Each one is processed, or carries nothing a verifier of
 * credential signatures has to enforce:
 *
 * - basicConstraints and keyUsage: checked by
 *   {@link assertCertificatePathConstraints} for every certificate above the
 *   signing certificate. ISO/IEC 18013-5 Annex B and EUDIPLO's own key
 *   chains mark both critical.
 * - extendedKeyUsage: ISO/IEC 18013-5 Annex B.1.4 marks the document signer's
 *   extended key usage critical. It restricts what the key may sign; EUDIPLO
 *   does not check its value, as for a non-critical one.
 * - subjectKeyIdentifier and authorityKeyIdentifier: used to build the path.
 * - subjectAltName and issuerAltName: names only. RFC 5280 section 4.2.1.6
 *   makes subjectAltName critical when the subject is empty.
 * - certificatePolicies: EUDIPLO validates with the initial policy set
 *   anyPolicy and without requiring an explicit policy, under which the RFC
 *   5280 policy checks cannot fail unless policyConstraints, policyMappings
 *   or inhibitAnyPolicy require it. Those three are not in this set.
 *
 * Not in the set, among others: nameConstraints, policyConstraints,
 * policyMappings, inhibitAnyPolicy (constraints EUDIPLO does not enforce),
 * CRL distribution points, freshest CRL and authority information access
 * (revocation and retrieval information EUDIPLO does not use for these
 * certificates), and any private extension.
 *
 * Limitation: RFC 5280 section 6.1.4 processes nameConstraints,
 * policyConstraints and inhibitAnyPolicy whenever they are present, and
 * sections 4.2.1.10 to 4.2.1.14 require conforming CAs to mark them
 * critical. A CA that breaks that rule and marks one of them non-critical
 * gets it ignored here, as any non-critical extension.
 */
export const PROCESSED_CRITICAL_EXTENSIONS: ReadonlyMap<string, string> =
    new Map([
        [BASIC_CONSTRAINTS, "basicConstraints"],
        [KEY_USAGE, "keyUsage"],
        ["2.5.29.37", "extendedKeyUsage"],
        ["2.5.29.14", "subjectKeyIdentifier"],
        ["2.5.29.35", "authorityKeyIdentifier"],
        ["2.5.29.17", "subjectAltName"],
        ["2.5.29.18", "issuerAltName"],
        ["2.5.29.32", "certificatePolicies"],
    ]);

/**
 * A certificate path breaks a constraint of RFC 5280 that
 * {@link assertCertificatePathConstraints} checks. `index` is the position of
 * the certificate in the path, the signing certificate at 0.
 */
export class CertificatePathConstraintViolation extends Error {
    constructor(
        readonly index: number,
        readonly subject: string,
        readonly reason: string,
    ) {
        super(
            `Certificate path constraint: ${reason} (subject="${subject}", index=${index})`,
        );
        this.name = "CertificatePathConstraintViolation";
    }
}

/**
 * Check the constraints of RFC 5280 section 6.1 that signatures and validity
 * periods leave out, on a path from the signing certificate (index 0) to the
 * certificate it is trusted through (last). Every certificate above the
 * signing certificate, the last one included, issues the one below it, so it
 * must:
 *
 * - carry basicConstraints with cA TRUE (section 6.1.4 (k); section 4.2.1.9
 *   forbids keyCertSign without cA);
 * - assert keyCertSign if it carries keyUsage (section 6.1.4 (n));
 * - have no more certificates below it, the signing certificate and
 *   self-issued certificates not counted, than its pathLenConstraint allows
 *   (sections 4.2.1.9 and 6.1.4 (l), (m)).
 *
 * No certificate of the path, the signing certificate included, may carry a
 * critical extension outside {@link PROCESSED_CRITICAL_EXTENSIONS} (sections
 * 4.2, 6.1.4 (o) and 6.1.5 (f)).
 *
 * Stricter than section 6.1.4 (k), which requires basicConstraints only of
 * version 3 certificates: a version 1 or 2 certificate cannot issue one of
 * the path either. ISO/IEC 18013-5 Annex B and HAIP require version 3.
 *
 * The signing certificate's own basicConstraints and keyUsage are not checked.
 * The last certificate is checked like the others: a trust list or the
 * trusted certificates of an mDOC name the certificate a path must end at,
 * not a trust anchor with constraints of its own.
 *
 * @param path The path, signing certificate first, as `CertificatePathBuilder`
 * builds it
 * @throws CertificatePathConstraintViolation for the first certificate, from
 * the signing certificate up, that breaks one of the constraints
 */
export function assertCertificatePathConstraints(
    path: readonly x509.X509Certificate[],
): void {
    path.forEach((cert, index) => {
        assertNoUnprocessedCriticalExtension(cert, index);
        if (index > 0) {
            assertIssuerConstraints(cert, index, path);
        }
    });
}

function assertNoUnprocessedCriticalExtension(
    cert: x509.X509Certificate,
    index: number,
): void {
    const unprocessed = cert.extensions.find(
        (extension) =>
            extension.critical &&
            !PROCESSED_CRITICAL_EXTENSIONS.has(extension.type),
    );
    if (unprocessed) {
        throw new CertificatePathConstraintViolation(
            index,
            cert.subject,
            `unsupported critical extension ${unprocessed.type}`,
        );
    }
}

function assertIssuerConstraints(
    cert: x509.X509Certificate,
    index: number,
    path: readonly x509.X509Certificate[],
): void {
    const basicConstraints = cert.getExtension(BASIC_CONSTRAINTS);
    if (
        !(basicConstraints instanceof x509.BasicConstraintsExtension) ||
        !basicConstraints.ca
    ) {
        throw new CertificatePathConstraintViolation(
            index,
            cert.subject,
            "issuing certificate is not a CA (basicConstraints cA is not TRUE)",
        );
    }

    const keyUsage = cert.getExtension(KEY_USAGE);
    if (
        keyUsage &&
        !(
            keyUsage instanceof x509.KeyUsagesExtension &&
            (keyUsage.usages & x509.KeyUsageFlags.keyCertSign) !== 0
        )
    ) {
        throw new CertificatePathConstraintViolation(
            index,
            cert.subject,
            "issuing certificate's keyUsage does not assert keyCertSign",
        );
    }

    const pathLength = basicConstraints.pathLength;
    if (pathLength !== undefined) {
        // Intermediate certificates between this one and the signing
        // certificate; self-issued ones do not count.
        const below = path
            .slice(1, index)
            .filter((inPath) => inPath.subject !== inPath.issuer).length;
        if (below > pathLength) {
            throw new CertificatePathConstraintViolation(
                index,
                cert.subject,
                `pathLenConstraint ${pathLength} allows fewer CA certificates below it than the path holds (${below})`,
            );
        }
    }
}
