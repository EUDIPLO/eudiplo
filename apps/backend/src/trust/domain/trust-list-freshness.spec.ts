import { describe, expect, it } from "vitest";
import {
    describeDiscardedTrustLists,
    discardedTrustListsNote,
    isTrustListCurrent,
    OutdatedTrustListsError,
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
            "No configured trust list is current: each has no valid NextUpdate or one that has passed",
        );
        expect(error.discarded).toHaveLength(1);
    });
});
