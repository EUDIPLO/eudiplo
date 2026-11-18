import { z } from "zod";

/**
 * A query parameter holding a point in time: ISO 8601 with an explicit
 * offset, so a range never depends on the server's time zone.
 */
export const timestamp = z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value));

/**
 * A query parameter that may be repeated: one value arrives as a string,
 * several as an array. Either way the result is an array.
 */
export function repeatable<T extends z.ZodType>(item: T) {
    return z
        .union([item, z.array(item)])
        .transform((value) =>
            Array.isArray(value)
                ? (value as z.output<T>[])
                : [value as z.output<T>],
        );
}

/** Zod refinement that rejects a time range whose start lies after its end. */
export function orderedRange<K extends string>(
    from: K,
    to: K,
): [
    (query: Partial<Record<K, Date>>) => boolean,
    { message: string; path: string[] },
] {
    return [
        (query) => !query[from] || !query[to] || query[from] <= query[to],
        { message: `${from} must not be after ${to}`, path: [from] },
    ];
}
