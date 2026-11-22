import React, { useEffect, useState } from "react";
import { type CellState, cellState, type Feed, formatDate, lastTested, latestPerWallet, parseFeed } from "./model";

/** Public Wallet QA instance whose published results this page shows. */
const INSTANCE = "https://conformance.eudiplo.dev";
const FEED_URL = `${INSTANCE}/v1/published`;
const RESULTS_URL = `${INSTANCE}/results`;

/**
 * Column headings: the abbreviations of the feature matrix legend in
 * docs/reference/wallet-compatibility.md, plus VP, which that page explains
 * above this table. Keep both in step.
 */
const SHORT_LABELS: Record<string, string> = {
    "authorization-code": "Auth",
    "pre-authorized-code": "Pre",
    dpop: "DPoP",
    "wallet-attestation": "Att",
    presentation: "VP",
    "dc-api": "DC API",
    "annex-c": "Annex C",
    "sd-jwt-vc": "SD-JWT",
    mdoc: "mdoc",
};

const CELLS: Record<CellState, { symbol: string; text: string }> = {
    passed: { symbol: "✅", text: "passed" },
    attested: { symbol: "☑️", text: "passed, tester-attested" },
    failed: { symbol: "❌", text: "failed" },
    inconclusive: { symbol: "❔", text: "inconclusive" },
    untested: { symbol: "—", text: "not run" },
    uncovered: { symbol: "○", text: "no Wallet QA test yet" },
};

/**
 * Published Wallet QA results, loaded in the browser from the public feed of
 * the hosted instance, so the table follows new results without a docs build.
 */
export default function WalletQaResults(): React.ReactElement {
    const [feed, setFeed] = useState<Feed | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        fetch(FEED_URL, { signal: controller.signal })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((body: unknown) => {
                const parsed = parseFeed(body);
                if (!parsed) throw new Error("unexpected feed format");
                setFeed(parsed);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                console.warn("Wallet QA results could not be loaded:", error);
                setFailed(true);
            });
        return () => controller.abort();
    }, []);

    if (failed) {
        return (
            <p role="status">
                The published results could not be loaded here. See them on the{" "}
                <a href={RESULTS_URL}>Wallet QA results page</a>.
            </p>
        );
    }
    if (!feed) {
        return <p role="status">Loading the published Wallet QA results…</p>;
    }
    const rows = latestPerWallet(feed.results);
    if (rows.length === 0) {
        return (
            <p role="status">
                No Wallet QA results have been published yet. Once a wallet team publishes its runs, they appear here and on
                the <a href={RESULTS_URL}>Wallet QA results page</a>.
            </p>
        );
    }
    const uncovered = feed.features.filter((feature) => !feature.covered);
    return (
        <>
            <table>
                <thead>
                    <tr>
                        <th scope="col">Wallet</th>
                        <th scope="col">Platform</th>
                        <th scope="col">Tested</th>
                        <th scope="col">Source</th>
                        {feed.features.map((feature) => (
                            <th scope="col" key={feature.id}>
                                <abbr title={feature.label}>{SHORT_LABELS[feature.id] ?? feature.label}</abbr>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((result) => (
                        <tr key={result.id}>
                            <th scope="row">
                                {result.wallet.name}
                                {result.wallet.version ? ` ${result.wallet.version}` : ""}
                            </th>
                            <td>{result.wallet.platform ?? ""}</td>
                            <td>{formatDate(lastTested(result))}</td>
                            <td>{result.provenance === "instance" ? "Wallet QA" : "self-reported"}</td>
                            {feed.features.map((feature) => {
                                const cell = CELLS[cellState(result, feature)];
                                return (
                                    <td key={feature.id}>
                                        <span aria-hidden="true">{cell.symbol}</span>
                                        <span className="sr-only">
                                            {feature.label}: {cell.text}
                                        </span>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
            <p>
                {Object.values(CELLS)
                    .map((cell) => `${cell.symbol} ${cell.text}`)
                    .join(" · ")}
                .{" "}
                {uncovered.length > 0 &&
                    `Wallet QA has no test yet for: ${uncovered.map((feature) => feature.label).join(", ")}. `}
                Each row is the latest published run of a wallet on one platform; the{" "}
                <a href={RESULTS_URL}>results page</a> has every run and test.
            </p>
        </>
    );
}
