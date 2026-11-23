/**
 * The published-results feed of Wallet QA (GET /v1/published) and how the
 * wallet compatibility page turns it into a table. No React here, so the
 * rules are unit-tested in model.test.ts.
 */

export type Verdict = "passed" | "failed" | "inconclusive" | "error";

export interface FeedFeature {
    id: string;
    label: string;
    /** false: no ready test in the catalog exercises this feature yet. */
    covered: boolean;
}

export interface FeedTest {
    scenarioId: string;
    features: string[];
    verdict: Verdict;
    attested: boolean;
    testedAt: string;
}

export interface FeedResult {
    id: string;
    provenance: "instance" | "self-reported";
    wallet: { name: string; version?: string; platform?: string };
    tests: FeedTest[];
}

export interface Feed {
    features: FeedFeature[];
    results: FeedResult[];
}

export type CellState = "passed" | "attested" | "failed" | "inconclusive" | "untested" | "uncovered";

const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";
const isDate = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value));

const isFeature = (value: unknown): value is FeedFeature =>
    isObject(value) && typeof value.id === "string" && typeof value.label === "string" && typeof value.covered === "boolean";

const isTest = (value: unknown): value is FeedTest =>
    isObject(value) &&
    Array.isArray(value.features) &&
    value.features.every((feature) => typeof feature === "string") &&
    typeof value.verdict === "string" &&
    typeof value.attested === "boolean" &&
    isDate(value.testedAt);

const isResult = (value: unknown): value is FeedResult =>
    isObject(value) &&
    typeof value.id === "string" &&
    (value.provenance === "instance" || value.provenance === "self-reported") &&
    isObject(value.wallet) &&
    typeof value.wallet.name === "string" &&
    isOptionalString(value.wallet.version) &&
    isOptionalString(value.wallet.platform) &&
    Array.isArray(value.tests) &&
    value.tests.every(isTest);

/**
 * The feed with only the entries the table can render, so one malformed entry
 * cannot break the page; null when the body is not a feed at all.
 */
export function parseFeed(value: unknown): Feed | null {
    if (!isObject(value) || !Array.isArray(value.features) || !Array.isArray(value.results)) return null;
    return { features: value.features.filter(isFeature), results: value.results.filter(isResult) };
}

/**
 * One feature of one result: the worst verdict among the tests that exercise it.
 * Only `failed` blames the wallet; `error` (a Wallet QA or EUDIPLO problem) and
 * verdicts this page does not know count as inconclusive.
 */
export function cellState(result: FeedResult, feature: FeedFeature): CellState {
    if (!feature.covered) return "uncovered";
    const tests = result.tests.filter((test) => test.features.includes(feature.id));
    if (tests.length === 0) return "untested";
    if (tests.some((test) => test.verdict === "failed")) return "failed";
    if (tests.some((test) => test.verdict !== "passed")) return "inconclusive";
    return tests.some((test) => test.attested) ? "attested" : "passed";
}

/** Time of the newest test of a result, in milliseconds; 0 without tests. */
export const lastTested = (result: FeedResult) =>
    result.tests.reduce((latest, test) => Math.max(latest, Date.parse(test.testedAt)), 0);

/**
 * The most recently tested result per wallet and platform, sorted by wallet
 * name. On equal times the higher ID wins, so the row does not depend on feed order.
 */
export function latestPerWallet(results: FeedResult[]): FeedResult[] {
    const latest = new Map<string, FeedResult>();
    for (const result of results) {
        const key = `${result.wallet.name.toLowerCase()}|${(result.wallet.platform ?? "").toLowerCase()}`;
        const current = latest.get(key);
        const newer = !current || lastTested(current) < lastTested(result);
        const tie = !!current && lastTested(current) === lastTested(result) && current.id < result.id;
        if (newer || tie) latest.set(key, result);
    }
    return [...latest.values()].sort((a, b) => a.wallet.name.localeCompare(b.wallet.name));
}

/** YYYY-MM-DD of a time in milliseconds; empty for 0. */
export const formatDate = (time: number) => (time ? new Date(time).toISOString().slice(0, 10) : "");
