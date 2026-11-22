import { DateOnly } from "@owf/mdoc";

/**
 * A data element value as released claims carry it: a `full-date` (CBOR tag
 * 1004) as `YYYY-MM-DD` and a `tdate` (CBOR tag 0) as an RFC 3339 date-time
 * in UTC with milliseconds, as `Date.toJSON()` wrote it into stored sessions
 * and webhooks before. Other values are returned unchanged;
 * dates inside arrays or maps are not converted.
 */
function releasedValue(value: unknown): unknown {
    if (value instanceof DateOnly) return value.toISOString();
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    return value;
}

/**
 * The data elements of one namespace with date values as strings, so DCQL
 * `values`, claim mappings and stored sessions see the same `YYYY-MM-DD`
 * an SD-JWT VC carries.
 */
export function withDateStrings(
    elements: Record<string, unknown>,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(elements).map(([name, value]) => [
            name,
            releasedValue(value),
        ]),
    );
}
