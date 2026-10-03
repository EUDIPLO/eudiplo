/**
 * Status value meaning "revoked" (Token Status List `0x01 INVALID`). The
 * status update API uses 0 = valid, 1 = revoked, 2 = suspended.
 */
export const STATUS_REVOKED = 1;

const STATUS_NAMES: Readonly<Record<number, string>> = {
    0: "valid",
    [STATUS_REVOKED]: "revoked",
    2: "suspended",
};

/** Bits per status entry a Token Status List can use. */
const BITS_PER_STATUS = [1, 2, 4, 8] as const;

/** Upper bound for the number of indexes named in an error message. */
const MAX_LISTED_INDEXES = 20;

/** The part of a status list that decides which values its entries can hold. */
interface StatusListLayout {
    id: string;
    bits: number;
}

/**
 * Whether `value` fits into one entry of a list with `bits` bits per entry,
 * that is `0 <= value <= 2 ** bits - 1`. A wider value cannot be encoded: its
 * extra bits would overwrite the neighbouring entries.
 */
export function statusValueFits(value: number, bits: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 2 ** bits - 1;
}

/**
 * A status value does not fit one or more of the status lists it was to be
 * written to. Nothing has been written. The message names the lists and the
 * bits they use, never credential or session data.
 */
export class StatusValueOutOfRange extends Error {
    constructor(value: number, lists: readonly StatusListLayout[]) {
        super(describeValueOutOfRange(value, lists));
        this.name = "StatusValueOutOfRange";
    }
}

/**
 * A stored status list contains values wider than its bits per entry, so it
 * cannot be encoded without changing the status of neighbouring entries.
 */
export class StatusListValuesOutOfRange extends Error {
    constructor(
        readonly listId: string,
        readonly bits: number,
        readonly indexes: readonly number[],
    ) {
        super(
            `Status list ${listId} stores values that do not fit its ${bitsLabel(bits)} per entry at ${indexes.length === 1 ? "index" : "indexes"} ${formatIndexes(indexes)}. Encoding them would change the status of neighbouring entries, so no status list token is published until these entries are set to a value the list can hold, for example 1 (revoked).`,
        );
        this.name = "StatusListValuesOutOfRange";
    }
}

/**
 * Reject `value` unless it fits every list it is about to be written to, so
 * that an update touching several lists is applied to all of them or none.
 * @throws StatusValueOutOfRange naming every list that is too narrow
 */
export function assertStatusValueFits(
    value: number,
    lists: readonly StatusListLayout[],
): void {
    const tooNarrow = lists.filter(
        (list) => !statusValueFits(value, list.bits),
    );
    if (tooNarrow.length > 0) {
        throw new StatusValueOutOfRange(value, tooNarrow);
    }
}

/**
 * Whether an entry may change from `current` to `next`. Revocation is final:
 * a revoked entry can only be set to revoked again. A suspension can be
 * lifted (0) or turned into a revocation (1).
 */
export function statusTransitionAllowed(
    current: number,
    next: number,
): boolean {
    return current !== STATUS_REVOKED || next === STATUS_REVOKED;
}

/** A status update tried to reinstate or suspend a revoked credential. */
export class RevokedStatusIsFinal extends Error {
    constructor(next: number) {
        super(
            `A revoked credential cannot be ${next === 0 ? "reinstated" : "suspended"}: revocation is final.`,
        );
        this.name = "RevokedStatusIsFinal";
    }
}

/**
 * @throws RevokedStatusIsFinal when `current` is revoked and `next` is not
 */
export function assertStatusTransitionAllowed(
    current: number,
    next: number,
): void {
    if (!statusTransitionAllowed(current, next)) {
        throw new RevokedStatusIsFinal(next);
    }
}

/**
 * Indexes of stored entries whose value does not fit `bits` bits, in
 * ascending order. Empty for a list that can be encoded as stored.
 */
export function findOutOfRangeStatusIndexes(
    elements: readonly number[],
    bits: number,
): number[] {
    const indexes: number[] = [];
    for (let index = 0; index < elements.length; index++) {
        if (!statusValueFits(elements[index], bits)) {
            indexes.push(index);
        }
    }
    return indexes;
}

function describeValueOutOfRange(
    value: number,
    lists: readonly StatusListLayout[],
): string {
    const name = STATUS_NAMES[value];
    const label = name ? `Status ${value} (${name})` : `Status ${value}`;
    const requiredBits = BITS_PER_STATUS.find((bits) =>
        statusValueFits(value, bits),
    );
    if (requiredBits === undefined) {
        return `${label} cannot be stored in a status list; status values are integers from 0 to 255.`;
    }
    const used = lists
        .map((list) => `list ${list.id} uses ${bitsLabel(list.bits)}`)
        .join(", ");
    return `${label} requires a status list with at least ${bitsLabel(requiredBits)} per entry; ${used}.`;
}

function bitsLabel(bits: number): string {
    return bits === 1 ? "1 bit" : `${bits} bits`;
}

function formatIndexes(indexes: readonly number[]): string {
    const listed = indexes.slice(0, MAX_LISTED_INDEXES).join(", ");
    const remaining = indexes.length - MAX_LISTED_INDEXES;
    return remaining > 0 ? `${listed} and ${remaining} more` : listed;
}
