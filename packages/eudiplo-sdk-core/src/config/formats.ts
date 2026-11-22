// Copy of packages/eudiplo-config-format/src/claim-formats.ts, which the
// backend uses and which this published package cannot depend on;
// test/formats-parity.spec.ts keeps both in step.
//
// Claim field `format` (CredentialConfig v5): the JSON Schema 2020-12 format
// of a `string` claim. Claims of such a field must be RFC 3339 strings; mDOC
// issuance encodes them as `full-date` (CBOR tag 1004, RFC 8943) or `tdate`
// (CBOR tag 0, RFC 8949), as ISO/IEC 18013-5 and the PID Rulebook require for
// date elements. SD-JWT VC issuance keeps the string. The SDK and the Web
// Client use this copy.

/** Formats a `string` claim field may declare. */
export const CLAIM_FIELD_FORMATS = ["date", "date-time"] as const;
export type ClaimFieldFormat = (typeof CLAIM_FIELD_FORMATS)[number];

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
    /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
    if (month === 2) {
        const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Whether `value` is an RFC 3339 `full-date` of an existing calendar day, such as `1964-08-12`. */
export function isFullDate(value: string): boolean {
    const match = FULL_DATE.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return (
        month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    );
}

/**
 * Whether `value` is an RFC 3339 `date-time`, such as `2026-11-20T10:00:00Z`.
 * Leap seconds (`:60`) are refused, since they have no instant to encode.
 */
export function isDateTime(value: string): boolean {
    const match = DATE_TIME.exec(value);
    if (!match || !isFullDate(match[1])) return false;
    const [hour, minute, second] = [match[2], match[3], match[4]].map(Number);
    if (hour > 23 || minute > 59 || second > 59) return false;
    if (match[7] !== undefined) {
        if (Number(match[7]) > 23 || Number(match[8]) > 59) return false;
    }
    return true;
}

/** The validator of each claim field format, for Ajv's `addFormat`. */
export const CLAIM_FIELD_FORMAT_VALIDATORS: Readonly<
    Record<ClaimFieldFormat, (value: string) => boolean>
> = {
    date: isFullDate,
    "date-time": isDateTime,
};
