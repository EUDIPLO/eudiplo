import {
    isDateTime,
    isFullDate,
} from "@eudiplo/config-format/claim-formats.js";
import { DateOnly } from "@owf/mdoc";
import { InvalidCredentialClaims } from "../../domain/credential-claims-validation.js";
import type { FormattedClaimField } from "../../utils/derive.js";

type Segment = string | number | null;

/**
 * The mDOC value of a claim whose field declares a `format`: a `full-date`
 * (`DateOnly`, CBOR tag 1004, RFC 8943) for `date` and a `tdate` (`Date`,
 * CBOR tag 0, which @owf/mdoc writes in UTC with whole seconds as ISO/IEC
 * 18013-5 asks) for `date-time`. Claim validation refuses other strings
 * first; the check here keeps a value that skipped it from being issued as
 * text again or failing as a 500.
 * @throws InvalidCredentialClaims naming the claim path, never the value
 */
function encodeDate(
    value: unknown,
    format: FormattedClaimField["format"],
    pointer: string,
): unknown {
    if (typeof value !== "string") return value;
    if (format === "date") {
        if (isFullDate(value)) return new DateOnly(value);
    } else if (isDateTime(value)) {
        const date = new Date(value);
        const year = date.getUTCFullYear();
        if (year >= 0 && year <= 9999) return date;
    }
    throw new InvalidCredentialClaims(
        `Claim ${pointer} must match format "${format}"`,
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replaces the values `path` selects in `target`, in place: a string selects
 * an own object key, a number an array element and `null` every array
 * element. Missing values are left alone.
 */
function replaceAtPath(
    target: unknown,
    path: Segment[],
    replace: (value: unknown, pointer: string) => unknown,
    pointer = "",
): void {
    const [segment, ...rest] = path;
    const visit = (
        container: Record<string, unknown> | unknown[],
        key: string | number,
    ) => {
        const childPointer = `${pointer}/${String(key)}`;
        const child = (container as Record<string, unknown>)[key];
        if (rest.length === 0) {
            (container as Record<string, unknown>)[key] = replace(
                child,
                childPointer,
            );
        } else {
            replaceAtPath(child, rest, replace, childPointer);
        }
    };
    if (segment === null || typeof segment === "number") {
        if (!Array.isArray(target)) return;
        if (segment === null) {
            target.forEach((_, index) => visit(target, index));
        } else if (segment < target.length) {
            visit(target, segment);
        }
        return;
    }
    if (segment === undefined || !isRecord(target)) return;
    if (Object.hasOwn(target, segment)) visit(target, segment);
}

/**
 * Encodes the date claims of `fields` in `target` as mDOC date values, in
 * place. `pathOf` picks the path: the claim path for resolved claims, the
 * namespace path for the defaults grouped by namespace.
 */
export function encodeMdocDateClaims(
    target: unknown,
    fields: FormattedClaimField[],
    pathOf: (field: FormattedClaimField) => Segment[],
): void {
    for (const field of fields) {
        replaceAtPath(target, pathOf(field), (value, pointer) =>
            encodeDate(value, field.format, pointer),
        );
    }
}
