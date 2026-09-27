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
