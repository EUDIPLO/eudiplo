import { DataItem } from "@owf/cose";
import { base64url } from "@owf/identity-common";

/**
 * A claim value as it is stored in the session and sent in webhooks: JSON,
 * except byte strings, which keep the form `JSON.stringify` gives them.
 */
export type MdocClaimValue =
    | string
    | number
    | boolean
    | null
    | Uint8Array
    | MdocClaimValue[]
    | { [key: string]: MdocClaimValue };

/**
 * Converts the decoded CBOR values of mDOC data elements into values that
 * `JSON.stringify` keeps, so that what is verified is what is stored and
 * returned. `JSON.stringify` alone writes a CBOR map (a JS `Map`) as `{}`
 * and throws on a 64-bit integer (a `bigint`).
 *
 * - map: object; text keys are kept, integer and boolean keys become their
 *   decimal or `true`/`false` text, byte string keys base64url, other keys
 *   the JSON text of their converted value. When two keys convert to the
 *   same text, the later one wins.
 * - array and set (tag 258): array.
 * - byte string, embedded CBOR (tag 24) and typed arrays (tags 64 to 87):
 *   left as bytes, so they serialise as before this conversion existed.
 * - integer outside the safe JavaScript range, including bignums (tags 2/3):
 *   decimal string; inside it: number.
 * - NaN, Infinity and undefined: `null`.
 * - tdate (tag 0) and epoch date (tag 1): `Date.toISOString()`;
 *   full-date (tag 1004): `YYYY-MM-DD`. An invalid date becomes `null`.
 * - other tags: `{ "value", "tag" }` with the converted value.
 * - an object reached a second time (value sharing, tags 28/29): `null`.
 *   Shared references can make a few bytes of CBOR describe an
 *   exponentially large tree, or a cycle; each decoded object is therefore
 *   converted once, which keeps the work linear in the decoded input.
 */
export function toJsonClaims(
    claims: Record<string, unknown>,
): Record<string, MdocClaimValue> {
    return toJsonObject(Object.entries(claims), new Set());
}

function toJsonValue(value: unknown, seen: Set<object>): MdocClaimValue {
    switch (typeof value) {
        case "string":
        case "boolean":
            return value;
        case "number":
            return Number.isFinite(value) ? value : null;
        case "bigint":
            return value >= Number.MIN_SAFE_INTEGER &&
                value <= Number.MAX_SAFE_INTEGER
                ? Number(value)
                : value.toString();
        case "object":
            break;
        default:
            return null;
    }
    if (value === null) {
        return null;
    }
    if (seen.has(value)) {
        return null;
    }
    seen.add(value);
    return toJsonObjectValue(value, seen);
}

function toJsonObjectValue(value: object, seen: Set<object>): MdocClaimValue {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof DataItem) {
        return value.buffer;
    }
    if (ArrayBuffer.isView(value)) {
        // Typed arrays other than byte strings serialise as before.
        return value as unknown as MdocClaimValue;
    }
    if (Array.isArray(value) || value instanceof Set) {
        return Array.from(value, (item) => toJsonValue(item, seen));
    }
    if (value instanceof Map) {
        return toJsonObject(
            Array.from(value, ([key, item]) => [toJsonKey(key, seen), item]),
            seen,
        );
    }
    // Date and DateOnly (@owf/cose) serialise themselves; an invalid
    // DateOnly throws instead of returning null like an invalid Date.
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
        try {
            return toJsonValue(toJSON.call(value), seen);
        } catch {
            return null;
        }
    }
    return toJsonObject(Object.entries(value), seen);
}

function toJsonKey(key: unknown, seen: Set<object>): string {
    if (typeof key === "string") {
        return key;
    }
    if (key instanceof Uint8Array) {
        return base64url.encode(key);
    }
    const converted = toJsonValue(key, seen);
    return typeof converted === "string"
        ? converted
        : JSON.stringify(converted);
}

/**
 * Defines the entries as own properties, so that a `__proto__` key stays a
 * claim instead of replacing the prototype.
 */
function toJsonObject(
    entries: [string, unknown][],
    seen: Set<object>,
): Record<string, MdocClaimValue> {
    const result: Record<string, MdocClaimValue> = {};
    for (const [key, item] of entries) {
        Object.defineProperty(result, key, {
            value: toJsonValue(item, seen),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return result;
}
