import { describe, expect, it } from "vitest";
import {
    isSupersededTrustList,
    isTrustListSequenceNumber,
} from "./trust-list-sequence.js";

describe("trust list sequence numbers", () => {
    it.each([
        ["1", 1, true],
        ["a large whole number", 2 ** 40, true],
        ["0", 0, false],
        ["a negative number", -1, false],
        ["a fraction", 1.5, false],
        ["a number beyond the safe range", 2 ** 53, false],
        ["a numeric string", "2", false],
        ["null", null, false],
        ["no value", undefined, false],
    ])("treats %s as a usable sequence number: %s", (_case, value, usable) => {
        expect(isTrustListSequenceNumber(value)).toBe(usable);
    });

    it.each([
        ["nothing was accepted before", 1, undefined, false],
        ["it is the list accepted before", 5, 5, false],
        ["it is newer", 6, 5, false],
        ["a newer list was accepted before", 4, 5, true],
    ])(
        "supersedes a list when %s: %s",
        (_case, sequenceNumber, highestAccepted, superseded) => {
            expect(isSupersededTrustList(sequenceNumber, highestAccepted)).toBe(
                superseded,
            );
        },
    );
});
