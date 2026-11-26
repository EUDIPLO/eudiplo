import * as x509 from "@peculiar/x509";
import { BoundedTtlCache } from "./bounded-ttl-cache.js";

/**
 * Parsed certificates, keyed by their encoding.
 *
 * Parsing a certificate decodes its whole ASN.1 structure. Key chain
 * certificates (looked up and checked for revocation on every issuance and
 * presentation offer) and the issuer certificates of trust lists (turned into
 * DCQL `aki` values for every presentation offer) are the same few
 * certificates each time, so they are parsed once and reused.
 *
 * The cache is process-wide and shared by all tenants. That is safe because
 * an entry is found only by its exact encoding, so a hit returns the same
 * public certificate the caller passed in. The bounds keep it small when many
 * different certificates pass through it; entries expire an hour after they
 * were parsed and are then parsed again.
 */
const cache = new BoundedTtlCache<x509.X509Certificate>({
    maxEntries: 512,
    maxBytes: 8 * 1024 * 1024,
});
const TTL_MS = 60 * 60 * 1000;

/**
 * Parse a certificate given as PEM or as base64-encoded DER (whitespace is
 * ignored), reusing the result for an encoding parsed before. Other string
 * encodings, such as hex, are not accepted.
 *
 * The returned object is shared between callers and must not be modified.
 *
 * @throws When the value is not a certificate. Failures are not cached.
 */
export function parseX509Certificate(encoded: string): x509.X509Certificate {
    const isPem = encoded.includes("-----BEGIN");
    const key = isPem ? encoded : encoded.replaceAll(/\s/g, "");
    const cached = cache.get(key);
    if (cached) {
        return cached;
    }
    const cert = new x509.X509Certificate(
        isPem ? key : Buffer.from(key, "base64"),
    );
    cache.set(
        key,
        cert,
        key.length + cert.rawData.byteLength,
        Date.now() + TTL_MS,
    );
    return cert;
}
