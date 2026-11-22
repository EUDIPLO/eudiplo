import assert from "node:assert/strict";
import { test } from "node:test";
import { cellState, type FeedResult, type FeedTest, formatDate, latestPerWallet, parseFeed } from "./model.js";

const feature = { id: "mdoc", label: "mdoc credentials", covered: true };

const run = (verdict: FeedTest["verdict"], extra: Partial<FeedTest> = {}): FeedTest => ({
    scenarioId: "s",
    features: ["mdoc"],
    verdict,
    attested: false,
    testedAt: "2026-11-20T09:00:00.000Z",
    ...extra,
});

const result = (tests: FeedTest[], wallet: Partial<FeedResult["wallet"]> = {}, id = "r"): FeedResult => ({
    id,
    provenance: "instance",
    wallet: { name: "Wallet", platform: "Android", ...wallet },
    tests,
});

test("a failure beats every other verdict", () => {
    assert.equal(cellState(result([run("passed"), run("error"), run("failed")]), feature), "failed");
});

test("an error is not the wallet's fault and shows as inconclusive", () => {
    assert.equal(cellState(result([run("passed"), run("error")]), feature), "inconclusive");
});

test("an inconclusive run turns a pass into inconclusive", () => {
    assert.equal(cellState(result([run("passed"), run("inconclusive")]), feature), "inconclusive");
});

test("one tester-attested pass marks the whole cell as tester-attested", () => {
    assert.equal(cellState(result([run("passed"), run("passed", { attested: true })]), feature), "attested");
    assert.equal(cellState(result([run("passed")]), feature), "passed");
});

test("a feature without a Wallet QA test is uncovered even when tests list it", () => {
    assert.equal(cellState(result([run("passed")]), { ...feature, covered: false }), "uncovered");
});

test("a feature no test of the result exercises is untested", () => {
    assert.equal(cellState(result([run("passed", { features: ["dpop"] })]), feature), "untested");
});

test("an unknown verdict from a newer feed is neither a pass nor a failure", () => {
    assert.equal(cellState(result([run("passed"), run("skipped" as FeedTest["verdict"])]), feature), "inconclusive");
});

test("results of one wallet and platform collapse case-insensitively to the newest", () => {
    const newer = result([run("passed", { testedAt: "2026-11-21T00:00:00Z" })], { name: "paradym", platform: "android" }, "new");
    const older = result([run("failed", { testedAt: "2026-11-20T00:00:00Z" })], { name: "Paradym", platform: "Android" }, "old");
    assert.deepEqual(
        latestPerWallet([newer, older]).map((r) => r.id),
        ["new"],
    );
    assert.deepEqual(
        latestPerWallet([older, newer]).map((r) => r.id),
        ["new"],
    );
});

test("newest is decided by time, not by how the timestamp is written", () => {
    const utc = result([run("passed", { testedAt: "2026-11-20T10:00:00Z" })], {}, "utc");
    const offset = result([run("passed", { testedAt: "2026-11-20T09:00:00-03:00" })], {}, "offset");
    assert.deepEqual(
        latestPerWallet([utc, offset]).map((r) => r.id),
        ["offset"],
    );
});

test("on equal times the higher ID wins, whatever the feed order", () => {
    const a = result([run("passed")], {}, "a");
    const b = result([run("failed")], {}, "b");
    assert.deepEqual(
        latestPerWallet([a, b]).map((r) => r.id),
        ["b"],
    );
    assert.deepEqual(
        latestPerWallet([b, a]).map((r) => r.id),
        ["b"],
    );
});

test("a result without a platform stays apart, and rows are sorted by wallet name", () => {
    const rows = latestPerWallet([
        result([run("passed")], { name: "Zeta" }, "z"),
        result([run("passed")], { name: "Alpha", platform: undefined }, "a-none"),
        result([run("passed")], { name: "Alpha" }, "a-android"),
    ]);
    assert.deepEqual(rows.map((r) => r.id).sort(), ["a-android", "a-none", "z"]);
    assert.deepEqual(
        rows.map((r) => r.wallet.name),
        ["Alpha", "Alpha", "Zeta"],
    );
});

test("parseFeed rejects bodies that are not a feed", () => {
    assert.equal(parseFeed(null), null);
    assert.equal(parseFeed({}), null);
    assert.equal(parseFeed({ features: [] }), null);
    assert.deepEqual(parseFeed({ features: [], results: [] }), { features: [], results: [] });
});

test("parseFeed drops malformed entries and keeps the rest", () => {
    const good = result([run("passed")]);
    const feed = parseFeed({
        features: [feature, { id: "x" }],
        results: [
            good,
            { id: "no-wallet", tests: [] },
            result([run("passed", { testedAt: "not a date" })], {}, "bad-date"),
            { ...good, id: "no-tests", tests: undefined },
            { ...good, id: "bad-provenance", provenance: "trusted" },
            result([run("passed", { attested: "false" as unknown as boolean })], {}, "string-attested"),
        ],
    });
    assert.deepEqual(feed?.features, [feature]);
    assert.deepEqual(
        feed?.results.map((r) => r.id),
        ["r"],
    );
});

test("formatDate prints the UTC day and nothing without tests", () => {
    assert.equal(formatDate(Date.parse("2026-11-20T23:30:00-03:00")), "2026-11-21");
    assert.equal(formatDate(0), "");
});
