import { isDeepStrictEqual } from "node:util";

/**
 * Whether an update changes a credential configuration's embedded disclosure
 * policy: adds one, changes it or deletes it (ARF Annex 2, EDP_11).
 *
 * Policies are compared by value: the order of object keys does not matter,
 * the order of array entries does. `$schema` is not part of the published
 * policy and is ignored, and a missing policy equals `null`.
 * @param stored The policy stored before the update.
 * @param requested The policy of the update; `undefined` leaves it unchanged.
 */
export function disclosurePolicyChanged(
    stored: unknown,
    requested: unknown,
): boolean {
    if (requested === undefined) {
        return false;
    }
    return !isDeepStrictEqual(comparable(stored), comparable(requested));
}

/** The published content of a policy, without `$schema` and undefined values. */
function comparable(policy: unknown): unknown {
    if (policy === undefined || policy === null) {
        return null;
    }
    const plain = JSON.parse(JSON.stringify(policy)) as unknown;
    if (plain !== null && typeof plain === "object" && !Array.isArray(plain)) {
        delete (plain as Record<string, unknown>)["$schema"];
    }
    return plain;
}
