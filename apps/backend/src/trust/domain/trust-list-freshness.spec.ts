import { describe, expect, it } from "vitest";
import {
    describeDiscardedTrustLists,
    discardedTrustListsNote,
    isTrustListCurrent,
    OutdatedTrustListsError,
    walletSafeTrustFailure,
} from "./trust-list-freshness.js";

describe("trust list freshness", () => {
    const now = new Date("2026-11-06T12:00:00Z");

    it.each([
        ["a later date", "2026-11-06T12:00:01Z", true],
        ["exactly now", "2026-11-06T12:00:00Z", false],
        ["a past date", "2026-11-01T00:00:00Z", false],
        ["no value", undefined, false],
        ["null (closed list)", null, false],
        ["an unreadable value", "soon", false],
    ])("treats %s as current: %s", (_case, nextUpdate, current) => {
        expect(isTrustListCurrent(nextUpdate, now)).toBe(current);
    });

    it("names each discarded list with its NextUpdate for operators", () => {
        expect(
            describeDiscardedTrustLists([
                { list: "https://a.example/list", nextUpdate: "2026-01-01" },
                { list: "managed-id", nextUpdate: null },
                { list: "https://b.example/list", nextUpdate: undefined },
            ]),
        ).toBe(
            'https://a.example/list (NextUpdate "2026-01-01"), managed-id (NextUpdate null), https://b.example/list (NextUpdate null)',
        );
    });

    it("names a list discarded for its sequence number with the number", () => {
        expect(
            describeDiscardedTrustLists([
                {
                    list: "https://a.example/list",
                    nextUpdate: "2026-12-01",
                    sequence: { number: 3, highestAccepted: 5 },
                },
                {
                    list: "https://m.example/list",
                    nextUpdate: "2026-12-01",
                    sequence: { number: 3, highestAccepted: 4, stored: true },
                },
                {
                    list: "https://b.example/list",
                    nextUpdate: "2026-12-01",
                    sequence: { number: undefined },
                },
                {
                    list: "https://c.example/list",
                    nextUpdate: "2026-12-01",
                    sequence: { number: '1"\n' },
                },
            ]),
        ).toBe(
            'https://a.example/list (LoTESequenceNumber 3 is lower than 5 accepted before), https://m.example/list (LoTESequenceNumber 3 is lower than 4 stored for this managed list), https://b.example/list (LoTESequenceNumber null is not a whole number from 1), https://c.example/list (LoTESequenceNumber "1\\"\\n" is not a whole number from 1)',
        );
    });

    it("escapes a signed NextUpdate, so it cannot break log lines", () => {
        expect(
            describeDiscardedTrustLists([{ list: "x", nextUpdate: 'a"\nb' }]),
        ).toBe('x (NextUpdate "a\\"\\nb")');
    });

    // These texts reach wallets: they must not name lists or dates, and add
    // nothing when no list was left out.
    it("adds no note to wallet answers when nothing was discarded", () => {
        expect(discardedTrustListsNote([])).toBe("");
    });

    it("counts discarded lists in the wallet note without naming them", () => {
        expect(
            discardedTrustListsNote([
                { list: "https://a.example/list", nextUpdate: "2026-01-01" },
                { list: "managed-id", nextUpdate: null },
            ]),
        ).toBe(
            " (2 outdated trust list(s) left out; the server log names them)",
        );
    });

    it("keeps lists and dates out of the error message", () => {
        const error = new OutdatedTrustListsError([
            { list: "https://a.example/list", nextUpdate: "2026-01-01" },
        ]);
        expect(error.message).toBe(
            "No configured trust list is current: each has no valid NextUpdate or one that has passed, no valid LoTESequenceNumber, or a lower one than a list accepted before",
        );
        expect(error.discarded).toHaveLength(1);
    });

    describe("walletSafeTrustFailure", () => {
        it("keeps the message of outdated lists, behind the prefix", () => {
            const error = new OutdatedTrustListsError([]);
            expect(walletSafeTrustFailure(error, "fixed", "Failed: ")).toEqual({
                message: `Failed: ${error.message}`,
                cause: error,
                outdated: true,
            });
        });

        it("answers the fixed text for any other error and keeps it as cause", () => {
            const error = new Error("Failed to fetch http://internal/list");
            expect(walletSafeTrustFailure(error, "fixed", "Failed: ")).toEqual({
                message: "fixed",
                cause: error,
                outdated: false,
            });
            expect(walletSafeTrustFailure("boom", "fixed")).toEqual({
                message: "fixed",
                cause: undefined,
                outdated: false,
            });
        });
    });
});
