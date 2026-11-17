import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A random secret: a client secret, an authorization code or the binding
 * cookie. 256 bits of randomness, base64url.
 */
export function generateOpaqueSecret(): string {
    return randomBytes(32).toString("base64url");
}

/**
 * SHA-256 of an opaque secret, base64url, as stored. The secrets carry 256
 * bits of entropy, so a fast hash suffices: there is nothing to guess.
 */
export function hashOpaqueSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("base64url");
}

/** Constant-time comparison of a stored hash with a presented secret. */
export function matchesOpaqueSecret(
    storedHash: string | null | undefined,
    presented: string | null | undefined,
): boolean {
    if (!storedHash || !presented) return false;
    const stored = Buffer.from(storedHash);
    const candidate = Buffer.from(hashOpaqueSecret(presented));
    return (
        stored.length === candidate.length && timingSafeEqual(stored, candidate)
    );
}
