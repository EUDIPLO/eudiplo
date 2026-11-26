import {
    parseSecretReference,
    type SecretReference,
} from "@eudiplo/config-format/config-values.js";
import {
    SecretMissingError,
    SecretReferenceInvalidError,
    SecretReferenceRefusedError,
    SecretUnavailableError,
} from "../domain/secret-errors.js";
import type { SecretUse } from "../domain/secret-use.js";
import type { SecretValue } from "../domain/secret-value.js";
import type { SecretSource } from "../ports/secret-source.js";
import type { SecretPolicy } from "./secret-policy.js";

export interface SecretResolverOptions {
    /** How long a value is used without asking the source again. */
    ttlMs: number;
    /**
     * How long after the TTL a value is still used while its source does
     * not answer. After that the use fails.
     */
    maxStaleMs: number;
    /** How long one read may take. */
    timeoutMs: number;
    /** How long a reference whose read failed is not read again. */
    cooldownMs: number;
    /**
     * How many values (and failed reads in their cooldown) are kept at most;
     * the least recently used go first.
     */
    maxEntries: number;
    now?: () => number;
    /**
     * Told when an expired value is used because its source failed, now or
     * during the cooldown of an earlier failure (then without a cause), so
     * the caller can log it. Never receives the value.
     */
    onStale?: (reference: string, cause: unknown) => void;
}

export const DEFAULT_SECRET_RESOLVER_OPTIONS: Omit<
    SecretResolverOptions,
    "now" | "onStale"
> = {
    ttlMs: 5 * 60_000,
    maxStaleMs: 60 * 60_000,
    timeoutMs: 2_000,
    cooldownMs: 30_000,
    maxEntries: 1_000,
};

interface CachedValue {
    value: SecretValue;
    fetchedAt: number;
}

class ReadTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`the source did not answer within ${timeoutMs} ms`);
        this.name = "ReadTimeoutError";
    }
}

/** Keeps at most `max` entries, dropping the least recently used. */
function remember<T>(map: Map<string, T>, key: string, value: T, max: number) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

/**
 * Resolves secret references when they are used. Values stay in this
 * process's memory only, for the TTL, and are never written anywhere.
 *
 * The policy is checked on every call, also for a cached value: a reference
 * that the operator no longer grants, or that is used in another field or
 * sent to another address, fails although it was resolved before.
 *
 * A failed read holds back only its own reference during the cooldown, so
 * a tenant whose reference fails does not stop the reads of others.
 */
export class SecretResolver {
    private readonly cache = new Map<string, CachedValue>();
    private readonly reading = new Map<string, Promise<SecretValue>>();
    /** Until when each reference whose read failed is not read again. */
    private readonly coolingUntil = new Map<string, number>();
    private readonly now: () => number;

    constructor(
        private readonly policy: SecretPolicy,
        private readonly options: SecretResolverOptions,
    ) {
        this.now = options.now ?? Date.now;
    }

    /**
     * Checks that `use` may name the reference, without reading it.
     *
     * @throws SecretReferenceInvalidError when `text` is no valid reference
     * @throws SecretReferenceRefusedError when the policy refuses it
     */
    check(text: string, use: SecretUse): SecretReference {
        const parsed = parseSecretReference(text);
        if (!parsed)
            throw new SecretReferenceInvalidError(
                "the value is no secret reference",
            );
        if (!parsed.ok) throw new SecretReferenceInvalidError(parsed.message);
        const reason = this.policy.refusal(parsed.reference, use);
        if (reason) throw new SecretReferenceRefusedError(text, reason);
        return parsed.reference;
    }

    /**
     * The value of the reference `text` for `use`.
     *
     * @throws what {@link check} throws
     * @throws SecretMissingError when the source has no value for it
     * @throws SecretUnavailableError when the source does not answer and
     * the last value is older than the TTL plus the stale window
     */
    async resolve(text: string, use: SecretUse): Promise<SecretValue> {
        const reference = this.check(text, use);
        // The policy refuses a reference without a source.
        const source = this.policy.source(reference.source) as SecretSource;
        const key = reference.reference;
        const cached = this.cache.get(key);
        const now = this.now();
        if (cached && now - cached.fetchedAt < this.options.ttlMs) {
            remember(this.cache, key, cached, this.options.maxEntries);
            return cached.value;
        }
        if (now < (this.coolingUntil.get(key) ?? 0))
            return this.stale(key, cached, undefined);
        let pending = this.reading.get(key);
        if (!pending) {
            pending = this.read(source, reference).finally(() =>
                this.reading.delete(key),
            );
            this.reading.set(key, pending);
        }
        return pending;
    }

    private async read(
        source: SecretSource,
        reference: SecretReference,
    ): Promise<SecretValue> {
        const key = reference.reference;
        let value: SecretValue | undefined;
        try {
            value = await this.withTimeout(source, reference);
        } catch (error) {
            remember(
                this.coolingUntil,
                key,
                this.now() + this.options.cooldownMs,
                this.options.maxEntries,
            );
            return this.stale(key, this.cache.get(key), error);
        }
        this.coolingUntil.delete(key);
        if (value === undefined) {
            // An answer, not a failure: a deleted secret is not served.
            this.cache.delete(key);
            throw new SecretMissingError(key);
        }
        remember(
            this.cache,
            key,
            { value, fetchedAt: this.now() },
            this.options.maxEntries,
        );
        return value;
    }

    /** The read, given up after the timeout also if the source ignores it. */
    private withTimeout(
        source: SecretSource,
        reference: SecretReference,
    ): Promise<SecretValue | undefined> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                const error = new ReadTimeoutError(this.options.timeoutMs);
                controller.abort(error);
                reject(error);
            }, this.options.timeoutMs);
        });
        // Through then(), so that a read that throws instead of rejecting
        // still clears the timer.
        const read = Promise.resolve().then(() =>
            source.read(reference, controller.signal),
        );
        return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
    }

    private stale(
        key: string,
        cached: CachedValue | undefined,
        cause: unknown,
    ): SecretValue {
        if (
            cached &&
            this.now() - cached.fetchedAt <
                this.options.ttlMs + this.options.maxStaleMs
        ) {
            this.options.onStale?.(key, cause);
            return cached.value;
        }
        throw new SecretUnavailableError(
            key,
            cause === undefined ? undefined : { cause },
        );
    }
}
