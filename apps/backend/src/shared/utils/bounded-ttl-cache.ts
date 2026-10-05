export interface BoundedTtlCacheLimits {
    /** Maximum number of entries. */
    maxEntries: number;
    /** Maximum sum of the sizes given to {@link BoundedTtlCache.set}. */
    maxBytes: number;
}

interface Entry<V> {
    value: V;
    bytes: number;
    expiresAt: number;
}

/**
 * In-memory cache whose entries expire at a given time, bounded by an entry
 * count and a byte budget.
 *
 * Expired entries are dropped when they are read and on every insert, so
 * entries for keys that are never read again do not stay in memory. When the
 * cache is full, the least recently used entries are evicted. An entry that
 * is larger than the whole byte budget is not cached.
 */
export class BoundedTtlCache<V> {
    /** Iterates from least to most recently used. */
    private readonly entries = new Map<string, Entry<V>>();
    private totalBytes = 0;

    constructor(private readonly limits: BoundedTtlCacheLimits) {}

    /** The value for `key`, unless it is missing or expired. */
    get(key: string): V | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (Date.now() >= entry.expiresAt) {
            this.delete(key);
            return undefined;
        }
        // Move to the end of the iteration order: most recently used.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    /**
     * Cache `value` until `expiresAt` (epoch milliseconds), replacing any
     * entry for `key`. `bytes` is the entry's size in the byte budget.
     *
     * @returns Whether the value was cached; it is not when it has already
     * expired or is larger than the byte budget.
     */
    set(key: string, value: V, bytes: number, expiresAt: number): boolean {
        this.delete(key);
        this.deleteExpired();

        if (Date.now() >= expiresAt || bytes > this.limits.maxBytes) {
            return false;
        }

        for (const [oldestKey] of this.entries) {
            if (
                this.entries.size < this.limits.maxEntries &&
                this.totalBytes + bytes <= this.limits.maxBytes
            ) {
                break;
            }
            this.delete(oldestKey);
        }

        this.entries.set(key, { value, bytes, expiresAt });
        this.totalBytes += bytes;
        return true;
    }

    delete(key: string): void {
        const entry = this.entries.get(key);
        if (entry) {
            this.entries.delete(key);
            this.totalBytes -= entry.bytes;
        }
    }

    /** Drop all expired entries. */
    deleteExpired(): void {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (now >= entry.expiresAt) {
                this.delete(key);
            }
        }
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    /** Number of entries, including expired ones not dropped yet. */
    get size(): number {
        return this.entries.size;
    }

    /** Sum of the entries' sizes. */
    get bytes(): number {
        return this.totalBytes;
    }

    keys(): IterableIterator<string> {
        return this.entries.keys();
    }
}
