// Shared rather than in issuer/status-list: the tenant schema (auth) and the
// config bundle plan (platform) check the same bound, and neither may import
// the issuer feature.

/** Upper bound for status list capacity; each list is held in memory while it is created. */
export const MAX_STATUS_LIST_CAPACITY = 1_000_000;

/** Message for a capacity outside 1..MAX_STATUS_LIST_CAPACITY. */
export const STATUS_LIST_CAPACITY_MESSAGE = `Status list capacity must be an integer between 1 and ${MAX_STATUS_LIST_CAPACITY}`;

/**
 * Whether `size` is a status list capacity EUDIPLO can allocate. The
 * capacity comes from API input, imported documents or tenant configuration
 * and sizes in-memory arrays, so every path that creates a list or stores a
 * default checks it.
 */
export function isStatusListCapacity(size: number): boolean {
    return (
        Number.isSafeInteger(size) &&
        size >= 1 &&
        size <= MAX_STATUS_LIST_CAPACITY
    );
}
