import { createPublicKey } from "node:crypto";

/** How long a fetched key set is used before it is fetched again. */
const DEFAULT_MAX_AGE_MS = 10 * 60_000;
/**
 * How long the last key set stays in use while fetches fail. After that every
 * token is refused, so that a key the provider withdrew is not accepted for
 * as long as its key set cannot be read.
 */
const DEFAULT_MAX_STALE_MS = 60 * 60_000;
/** Minimum time between two fetches, whatever the tokens ask for. */
const DEFAULT_COOLDOWN_MS = 30_000;

interface JwksKeySetOptions {
    jwksUri: string;
    fetcher: (jwksUri: string) => Promise<{ keys: unknown }>;
    maxAgeMs?: number;
    maxStaleMs?: number;
    cooldownMs?: number;
    now?: () => number;
    /** Called when a fetch fails; the last key set that could be read stays in use. */
    onFetchError?: (error: unknown) => void;
}

/**
 * The identity provider's signing keys, fetched at most once per cooldown.
 *
 * Tokens choose the `kid` they are looked up by, so an unknown `kid` must not
 * be able to force fetches: a known `kid` is answered from the last key set
 * that could be read, also after it has aged or a fetch failed (for at most
 * `maxStaleMs` after the last successful fetch), and an
 * unknown `kid` fetches the set again only once the cooldown has passed.
 * Every fetch returns the whole set, so a key the provider adds, for example
 * when it rotates its keys, is found by the next fetch whoever triggers it.
 */
export class JwksKeySet {
    private readonly maxAgeMs: number;
    private readonly maxStaleMs: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;
    private keys = new Map<string | undefined, string>();
    private fetchedAt = Number.NEGATIVE_INFINITY;
    private attemptedAt = Number.NEGATIVE_INFINITY;
    private inflight?: Promise<void>;

    constructor(private readonly options: JwksKeySetOptions) {
        this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
        this.maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
        this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.now = options.now ?? Date.now;
    }

    /**
     * The PEM public key for `kid`. A token without `kid` gets the only key
     * of the set; with several keys it is refused.
     */
    async getKey(kid: string | undefined): Promise<string> {
        const stale = this.now() - this.fetchedAt >= this.maxAgeMs;
        if ((stale || !this.find(kid)) && this.mayFetch()) {
            try {
                await this.refresh();
            } catch (error) {
                // Keep using the last key set that could be read.
                this.options.onFetchError?.(error);
                if (!this.find(kid)) throw error;
            }
        }
        const key = this.find(kid);
        if (!key) {
            throw new Error(
                kid === undefined
                    ? "The token names no key (kid) and the identity provider has several signing keys"
                    : `The identity provider has no signing key '${kid}'`,
            );
        }
        return key;
    }

    private find(kid: string | undefined): string | undefined {
        if (this.now() - this.fetchedAt >= this.maxStaleMs) return undefined;
        if (kid !== undefined) return this.keys.get(kid);
        return this.keys.size === 1
            ? this.keys.values().next().value
            : undefined;
    }

    private mayFetch(): boolean {
        return (
            this.inflight !== undefined ||
            this.now() - this.attemptedAt >= this.cooldownMs
        );
    }

    /** One fetch at a time; concurrent callers wait for the same one. */
    private refresh(): Promise<void> {
        this.inflight ??= this.fetch().finally(() => {
            this.inflight = undefined;
        });
        return this.inflight;
    }

    private async fetch(): Promise<void> {
        this.attemptedAt = this.now();
        const { keys } = await this.options.fetcher(this.options.jwksUri);
        const signingKeys = new Map<string | undefined, string>();
        for (const jwk of Array.isArray(keys) ? keys : []) {
            const pem = signingKeyPem(jwk);
            const kid = jwkKid(jwk);
            // The first key of a kid wins, as with jwks-rsa.
            if (pem && !signingKeys.has(kid)) signingKeys.set(kid, pem);
        }
        if (signingKeys.size === 0) {
            throw new Error(
                `The key set at ${this.options.jwksUri} contains no signing keys`,
            );
        }
        this.keys = signingKeys;
        this.fetchedAt = this.now();
    }
}

function jwkKid(jwk: { kid?: unknown }): string | undefined {
    return typeof jwk.kid === "string" ? jwk.kid : undefined;
}

/** The PEM of a public signing key (RSA, EC or OKP), or undefined for any other key. */
function signingKeyPem(jwk: unknown): string | undefined {
    if (typeof jwk !== "object" || jwk === null) return undefined;
    const { use, kty } = jwk as { use?: unknown; kty?: unknown };
    if (use !== undefined && use !== "sig") return undefined;
    if (kty !== "RSA" && kty !== "EC" && kty !== "OKP") return undefined;
    try {
        return createPublicKey({ key: jwk as never, format: "jwk" })
            .export({ type: "spki", format: "pem" })
            .toString();
    } catch {
        return undefined;
    }
}
