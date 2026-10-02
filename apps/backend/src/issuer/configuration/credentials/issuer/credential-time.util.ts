/** Granularity for credential time claims so batch credentials are not linkable (RFC 9901 Section 10.1). */
const CREDENTIAL_TIME_GRANULARITY_SECONDS = 3600;

/**
 * Issuance time rounded down and expiry rounded up, so validity never shrinks.
 */
export function roundedCredentialValidity(
    lifeTimeSeconds: number,
    nowMs = Date.now(),
): { issuedAt: number; expiresAt: number } {
    const now = Math.floor(nowMs / 1000);
    const g = CREDENTIAL_TIME_GRANULARITY_SECONDS;
    return {
        issuedAt: Math.floor(now / g) * g,
        expiresAt: Math.ceil((now + lifeTimeSeconds) / g) * g,
    };
}

/**
 * Keeps a rounded credential validity inside the signing certificate's validity,
 * as ISO 18013-5 requires the MSO signed date to lie within it. Clamping to the
 * certificate bounds leaks nothing, since the certificate travels with the
 * credential. Throws when the certificate is not valid right now.
 */
export function clampCredentialValidityToCertificate(
    validity: { issuedAt: number; expiresAt: number },
    certificate: { notBefore: Date; notAfter: Date },
    nowMs = Date.now(),
): { issuedAt: number; expiresAt: number } {
    const notBefore = Math.ceil(certificate.notBefore.getTime() / 1000);
    const notAfter = Math.floor(certificate.notAfter.getTime() / 1000);
    const now = Math.floor(nowMs / 1000);

    if (now < notBefore || now > notAfter) {
        throw new Error(
            `Signing certificate is not valid at issuance time (${new Date(nowMs).toISOString()}); validity is ${certificate.notBefore.toISOString()} to ${certificate.notAfter.toISOString()}`,
        );
    }

    return {
        issuedAt: Math.max(validity.issuedAt, notBefore),
        expiresAt: Math.min(validity.expiresAt, notAfter),
    };
}
