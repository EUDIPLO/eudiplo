import { describe, expect, test } from "vitest";
import {
    assertStatusValueFits,
    findOutOfRangeStatusIndexes,
    StatusListValuesOutOfRange,
    StatusValueOutOfRange,
    statusValueFits,
} from "./status-value.js";

describe("statusValueFits", () => {
    test.each([
        [0, 1, true],
        [1, 1, true],
        [2, 1, false],
        [2, 2, true],
        [3, 2, true],
        [4, 2, false],
        [15, 4, true],
        [16, 4, false],
        [255, 8, true],
        [256, 8, false],
    ])("value %s with %s bit(s) per entry: %s", (value, bits, fits) => {
        expect(statusValueFits(value, bits)).toBe(fits);
    });

    test.each([-1, 0.5, Number.NaN])("rejects %s", (value) => {
        expect(statusValueFits(value, 8)).toBe(false);
    });
});

describe("assertStatusValueFits", () => {
    test("accepts a value that fits every list", () => {
        expect(() =>
            assertStatusValueFits(1, [
                { id: "narrow", bits: 1 },
                { id: "wide", bits: 2 },
            ]),
        ).not.toThrow();
    });

    test("names the lists that are too narrow and the bits required", () => {
        let error: unknown;
        try {
            assertStatusValueFits(2, [
                { id: "narrow", bits: 1 },
                { id: "wide", bits: 2 },
                { id: "other-narrow", bits: 1 },
            ]);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(StatusValueOutOfRange);
        expect((error as Error).message).toBe(
            "Status 2 (suspended) requires a status list with at least 2 bits per entry; list narrow uses 1 bit, list other-narrow uses 1 bit.",
        );
    });

    test("explains a value that no status list can hold", () => {
        expect(() =>
            assertStatusValueFits(256, [{ id: "list", bits: 8 }]),
        ).toThrow(
            "Status 256 cannot be stored in a status list; status values are integers from 0 to 255.",
        );
    });
});

describe("findOutOfRangeStatusIndexes", () => {
    test("is empty for a list that can be encoded as stored", () => {
        expect(findOutOfRangeStatusIndexes([0, 1, 0, 1], 1)).toEqual([]);
        expect(findOutOfRangeStatusIndexes([0, 2, 3, 1], 2)).toEqual([]);
    });

    test("lists every entry wider than the bits per entry", () => {
        expect(findOutOfRangeStatusIndexes([2, 0, 1, 2, 0], 1)).toEqual([0, 3]);
    });
});

describe("StatusListValuesOutOfRange", () => {
    test("names the list, its bits and the affected indexes", () => {
        const error = new StatusListValuesOutOfRange("list-1", 1, [3]);

        expect(error.message).toContain(
            "Status list list-1 stores values that do not fit its 1 bit per entry at index 3.",
        );
    });

    test("abbreviates long index lists", () => {
        const indexes = Array.from({ length: 25 }, (_, index) => index);
        const error = new StatusListValuesOutOfRange("list-1", 1, indexes);

        expect(error.message).toContain(
            "at indexes 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19 and 5 more.",
        );
    });
});
