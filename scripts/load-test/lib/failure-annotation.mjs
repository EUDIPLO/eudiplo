#!/usr/bin/env node
/**
 * GitHub Actions error annotation for a failed k6 scenario, so the reason is
 * visible on the PR checks without downloading the artifact.
 *
 * Usage: node lib/failure-annotation.mjs SCENARIO PROFILE SUMMARY.json K6.log
 *
 * The message lists what failed, as recorded by lib/summary.ts in the JSON
 * summary (`failures`: breached thresholds and failed checks), then the most
 * frequent distinct k6 error lines of the log, such as a fail() with status
 * and response body. Either file may be missing or unreadable: k6 can fail
 * before it writes a summary.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINE = 400;
const MAX_FAILURES = 20;

/**
 * The `limit` most frequent distinct `level=error` messages of a k6 log,
 * prefixed with their count. Messages are grouped by their text up to
 * ". Body:", so the same error with different response bodies counts once;
 * the first body seen is kept as an example. Timestamps, logfmt fields after
 * the message and Go stack tails are dropped; k6's own "thresholds ... have
 * been crossed" line is skipped because the failures already say it.
 */
export function topErrors(logText, limit = 5) {
    const groups = new Map();
    for (const raw of logText.split('\n')) {
        if (!raw.includes('level=error')) continue;
        if (/thresholds on metrics .* have been crossed/.test(raw)) continue;
        const msg = /msg="((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        const text = msg.replace(/\\n\\tat .*$/, '').slice(0, MAX_LINE);
        const key = text.split('. Body:')[0];
        const g = groups.get(key) ?? { count: 0, example: text };
        g.count++;
        groups.set(key, g);
    }
    return [...groups.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map((g) => `${g.count}× ${g.example}`);
}

/** Escape a message for a workflow command: % first, then CR and LF. */
export function escapeCommandMessage(message) {
    return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape an annotation property value (the title). */
export function escapeCommandProperty(value) {
    return escapeCommandMessage(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * The `::error` workflow command. `summary` is the parsed JSON summary, or a
 * string describing why there is none.
 */
export function buildAnnotation({ scenario, profile, summary, logText, logName }) {
    const failures = Array.isArray(summary?.failures) ? summary.failures.slice(0, MAX_FAILURES) : [];
    const lines = [...failures, ...topErrors(logText ?? '')];
    if (typeof summary === 'string') lines.push(summary);
    const message =
        lines.length > 0 ? lines.join('\n') : `k6 exited with an error; see ${logName} in the artifact.`;
    const title = escapeCommandProperty(`k6 ${scenario} (${profile}) failed`);
    return `::error title=${title}::${escapeCommandMessage(message)}`;
}

/** Read the summary file: the parsed JSON, or why it is unavailable. */
export function readSummary(path) {
    if (!path || !existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        return `Summary ${basename(path)} is unreadable: ${e.message}`;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [scenario, profile, summaryPath, logPath] = process.argv.slice(2);
    const logText = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    console.log(
        buildAnnotation({
            scenario,
            profile,
            summary: readSummary(summaryPath),
            logText,
            logName: basename(logPath ?? 'k6.log'),
        }),
    );
}
