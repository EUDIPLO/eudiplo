#!/usr/bin/env node
/**
 * Compare k6 summaries against the committed latency baseline.
 *
 * Usage:
 *   node compare-baseline.mjs [--update] [--baseline FILE] [--markdown FILE] SUMMARY.json...
 *
 * Each SUMMARY.json is a file written by lib/summary.ts (SUMMARY_FILE). For
 * every `http_req_duration{stage:...}` metric the p95 is compared with the
 * baseline entry for the same profile, scenario and stage.
 *
 *   BASELINE_TOLERANCE   allowed p95 increase as a fraction (default 0.2 = +20 %)
 *   BASELINE_MIN_MS      ignore increases of at most this many ms (default 5),
 *                        so sub-10 ms stages do not flap on runner noise
 *   BASELINE_ENFORCE     "true" to exit 1 on a regression (default: report only)
 *
 * Exit codes: 0 no regression (or not enforced), 1 regression with
 * BASELINE_ENFORCE=true, 2 usage error or unreadable summary/baseline.
 *
 * --update writes the p95 values of the given summaries into the baseline
 * (only for the profiles and scenarios they contain) instead of comparing.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    compareSummaries,
    comparisonMarkdown,
    updateBaseline,
} from './lib/baseline.mjs';

/** A non-negative number from the environment; a typo must not disable the check. */
function nonNegative(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
    return n;
}

function main() {
    const here = dirname(fileURLToPath(import.meta.url));
    const args = process.argv.slice(2);
    let update = false;
    let baselinePath = join(here, 'baseline.json');
    let markdownPath;
    const summaryPaths = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--update') update = true;
        else if (a === '--baseline') baselinePath = args[++i];
        else if (a === '--markdown') markdownPath = args[++i];
        else if (a === '--help' || a === '-h') {
            console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
            return 0;
        } else summaryPaths.push(a);
    }
    if (summaryPaths.length === 0) {
        console.error('No summary files given.');
        return 2;
    }

    const options = {
        tolerance: nonNegative('BASELINE_TOLERANCE', 0.2),
        minMs: nonNegative('BASELINE_MIN_MS', 5),
    };
    const enforce = (process.env.BASELINE_ENFORCE ?? 'false') === 'true';

    const summaries = summaryPaths.map((p) => {
        try {
            return JSON.parse(readFileSync(p, 'utf8'));
        } catch (e) {
            throw new Error(`${p}: ${e.message}`);
        }
    });
    const baseline = existsSync(baselinePath)
        ? JSON.parse(readFileSync(baselinePath, 'utf8'))
        : { profiles: {} };

    if (update) {
        writeFileSync(baselinePath, `${JSON.stringify(updateBaseline(baseline, summaries), null, 2)}\n`);
        for (const s of summaries) console.log(`baseline: ${s.profile}/${s.scenario} updated`);
        return 0;
    }

    const result = compareSummaries(baseline, summaries, options);
    const table = comparisonMarkdown(result, options);
    console.log(table);
    if (markdownPath) appendFileSync(markdownPath, `${table}\n`);

    if (result.regressions > 0) {
        console.log(`${result.regressions} stage(s) regressed beyond the tolerance.`);
        if (enforce) return 1;
    }
    return 0;
}

try {
    process.exitCode = main();
} catch (e) {
    console.error(`compare-baseline: ${e.message}`);
    process.exitCode = 2;
}
