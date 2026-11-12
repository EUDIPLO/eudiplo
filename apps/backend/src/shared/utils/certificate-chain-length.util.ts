/**
 * The most certificates EUDIPLO reads from an `x5c` (JOSE) or `x5chain`
 * (COSE) header: the chain of a credential, a presentation, a wallet or key
 * attestation, or a status list. HAIP chains hold the signing certificate and
 * a few intermediates; the trust anchor is not part of them.
 *
 * `@peculiar/x509`'s `X509ChainBuilder.build` has no depth limit. At every
 * step it scans the whole pool for issuers, verifies a signature for every
 * certificate with the issuer's name, and hashes every certificate already in
 * the chain, so a long chain costs work that grows with the square of its
 * length. A status list from a host the attacker controls, or a key
 * attestation in a request body, could otherwise keep the server busy for
 * minutes with one chain.
 */
export const MAX_CERTIFICATE_CHAIN_LENGTH = 10;

/** An `x5c` or `x5chain` holds more than {@link MAX_CERTIFICATE_CHAIN_LENGTH} certificates. */
export class CertificateChainTooLong extends Error {
    constructor(length: number, header: "x5c" | "x5chain") {
        super(
            `${header} holds ${length} certificates; at most ${MAX_CERTIFICATE_CHAIN_LENGTH} are accepted`,
        );
        this.name = "CertificateChainTooLong";
    }
}

/**
 * Refuse an `x5c` or `x5chain` with more than
 * {@link MAX_CERTIFICATE_CHAIN_LENGTH} certificates. Call it before the
 * certificates are parsed. A header value that is not an array is left to
 * the caller, which rejects it as malformed.
 * @param chain The certificates, encoded or parsed
 * @param header The header the chain came from, for the message
 * @throws CertificateChainTooLong if the chain is longer
 */
export function assertCertificateChainLength(
    chain: readonly unknown[],
    header: "x5c" | "x5chain" = "x5c",
): void {
    if (Array.isArray(chain) && chain.length > MAX_CERTIFICATE_CHAIN_LENGTH) {
        throw new CertificateChainTooLong(chain.length, header);
    }
}
