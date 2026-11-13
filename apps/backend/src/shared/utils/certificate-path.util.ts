import * as x509 from "@peculiar/x509";

/**
 * The most certificates in a path EUDIPLO builds, the signing certificate
 * and the certificate the path ends at included: a presented chain
 * (`MAX_CERTIFICATE_CHAIN_LENGTH`) and the listed certificates above it.
 */
export const MAX_CERTIFICATE_PATH_LENGTH = 16;

/**
 * The most signatures EUDIPLO verifies while building one certificate path.
 * Each step from a certificate to its issuer verifies its signature against
 * every candidate in the pool whose subject is that certificate's issuer
 * name, unless the candidate's subject key identifier differs from the
 * certificate's authority key identifier, until one verifies. A trust list
 * lists any certificates its publisher chooses, so without a budget
 * thousands of certificates with one subject and no subject key identifier
 * would cost thousands of signature checks for every chain that names that
 * subject as issuer.
 */
export const MAX_PATH_SIGNATURE_CHECKS = 64;

const AUTHORITY_KEY_IDENTIFIER = "2.5.29.35";
const SUBJECT_KEY_IDENTIFIER = "2.5.29.14";

/**
 * Matches the message of {@link CertificatePathLimitExceeded}, for callers
 * that receive only the message, such as the mDOC verifier from @owf/mdoc.
 */
export const CERTIFICATE_PATH_LIMIT_FAILURE =
    /certificate path (?:is longer than \d+ certificates|not found within \d+ signature checks)/i;

/** Building a certificate path took more than the limit allows. */
export class CertificatePathLimitExceeded extends Error {
    constructor(readonly limit: "length" | "signatureChecks") {
        super(
            limit === "length"
                ? `Certificate path is longer than ${MAX_CERTIFICATE_PATH_LENGTH} certificates`
                : `Certificate path not found within ${MAX_PATH_SIGNATURE_CHECKS} signature checks`,
        );
        this.name = "CertificatePathLimitExceeded";
    }
}

/** The signature checks one path may still take. */
class SignatureCheckBudget {
    private spent = 0;

    /** Count a check. @throws CertificatePathLimitExceeded when none is left */
    spend(): void {
        if (this.spent === MAX_PATH_SIGNATURE_CHECKS) {
            throw new CertificatePathLimitExceeded("signatureChecks");
        }
        this.spent++;
    }
}

/**
 * Builds a certificate path from a pool the way `@peculiar/x509`'s
 * `X509ChainBuilder.build` does, within {@link MAX_CERTIFICATE_PATH_LENGTH}
 * and {@link MAX_PATH_SIGNATURE_CHECKS}. `X509ChainBuilder.build` has no
 * limit; its `buildToAnchor` has limits, but orders candidate issuers by
 * itself, while callers rely on the order of the pool.
 *
 * From the starting certificate, each step takes the first certificate of the
 * pool, in pool order, whose subject equals the current certificate's issuer
 * name, whose subject key identifier, if both are present, equals the
 * current certificate's authority key identifier, and whose key verifies the
 * current certificate's signature. The path ends at a self-signed
 * certificate or where no issuer is found; it is not checked against trust
 * anchors, validity periods or constraints. Unlike `X509ChainBuilder`, it
 * does not skip candidates by an authority key identifier given only as
 * issuer name and serial number (no key identifier): their signature is
 * checked like any other candidate's.
 */
export class CertificatePathBuilder {
    constructor(
        private readonly certificates: readonly x509.X509Certificate[],
    ) {}

    /**
     * The path from `cert` up, `cert` first.
     * @throws CertificatePathLimitExceeded if the path would hold more than
     * {@link MAX_CERTIFICATE_PATH_LENGTH} certificates, or finding it needs
     * more than {@link MAX_PATH_SIGNATURE_CHECKS} signature checks
     * @throws if a certificate would appear twice in the path
     */
    async build(cert: x509.X509Certificate): Promise<x509.X509Certificate[]> {
        const checks = new SignatureCheckBudget();
        const path = [cert];
        let issuer = await this.findIssuer(cert, checks);
        while (issuer) {
            const next = issuer;
            if (path.some((inPath) => inPath.equal(next))) {
                throw new Error(
                    "Cannot build a certificate chain. Circular dependency.",
                );
            }
            if (path.length === MAX_CERTIFICATE_PATH_LENGTH) {
                throw new CertificatePathLimitExceeded("length");
            }
            path.push(next);
            issuer = await this.findIssuer(next, checks);
        }
        return path;
    }

    private async findIssuer(
        cert: x509.X509Certificate,
        checks: SignatureCheckBudget,
    ): Promise<x509.X509Certificate | null> {
        if (cert.subject === cert.issuer) {
            checks.spend();
            if (await cert.verify({ signatureOnly: true })) {
                return null;
            }
        }
        const authorityKeyId =
            cert.getExtension<x509.AuthorityKeyIdentifierExtension>(
                AUTHORITY_KEY_IDENTIFIER,
            )?.keyId;
        for (const candidate of this.certificates) {
            if (candidate.subject !== cert.issuer) continue;
            if (authorityKeyId) {
                const subjectKeyId =
                    candidate.getExtension<x509.SubjectKeyIdentifierExtension>(
                        SUBJECT_KEY_IDENTIFIER,
                    )?.keyId;
                if (subjectKeyId && subjectKeyId !== authorityKeyId) continue;
            }
            checks.spend();
            if (await this.signedBy(cert, candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /** Whether `issuer`'s key verifies `cert`'s signature; false if it cannot be checked. */
    private async signedBy(
        cert: x509.X509Certificate,
        issuer: x509.X509Certificate,
    ): Promise<boolean> {
        try {
            return await cert.verify({
                publicKey: issuer,
                signatureOnly: true,
            });
        } catch {
            return false;
        }
    }
}
