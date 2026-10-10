/**
 * Every DCQL credential query of a presentation config must name a trusted
 * authority, an `etsi_tl` trust list or an `openid_federation` trust anchor.
 * Without one, any validly signed issuer would be accepted (see
 * {@link verifierTrustOptions}). `SKIP_TRUST_AUTHORITY` lifts the requirement
 * for development and interoperability tests.
 *
 * Pure function; the caller decides how a violation is reported.
 */

/** The subset of a DCQL credential query the requirement needs. */
export interface CredentialQueryAuthorities {
    id: string;
    trusted_authorities?: ReadonlyArray<{ values?: readonly unknown[] }>;
}

/**
 * Why the credential queries violate the requirement, or undefined when each
 * has a `trusted_authorities` entry with at least one value, or `skip` is set.
 */
export function missingTrustedAuthorities(
    credentials: readonly CredentialQueryAuthorities[],
    skip: boolean,
): string | undefined {
    if (skip) {
        return undefined;
    }
    const missing = credentials
        .filter(
            (credential) =>
                !credential.trusted_authorities?.some(
                    (authority) => (authority.values?.length ?? 0) > 0,
                ),
        )
        .map((credential) => credential.id);
    if (missing.length === 0) {
        return undefined;
    }
    return `Credential queries without trusted_authorities: ${missing.join(", ")}. Add a trust list or an OpenID Federation trust anchor to each, or set SKIP_TRUST_AUTHORITY=true for development and interoperability tests.`;
}
