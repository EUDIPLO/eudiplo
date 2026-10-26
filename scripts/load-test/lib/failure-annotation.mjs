#!/usr/bin/env node
/**
 * GitHub Actions error annotation for a failed k6 scenario, so the reason is
 * visible on the PR checks without downloading the artifact.
 *
 * Usage: node lib/failure-annotation.mjs SCENARIO PROFILE SUMMARY.json K6.log [BACKEND.log]
 *        node lib/failure-annotation.mjs --count-backend BACKEND.log
 *
 * --count-backend prints "Backend log lines during the run: N ERROR/FATAL,
 * M WARN" for the run report.
 *
 * The message lists what failed, as recorded by lib/summary.ts in the JSON
 * summary (`failures`: breached thresholds and failed checks), then the most
 * frequent distinct k6 error lines of the log, such as a fail() with status
 * and response body, then the most frequent distinct WARN/ERROR messages the
 * backend logged during the scenario (when the runner captured them). Any
 * file may be missing or unreadable: k6 can fail before it writes a summary.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINE = 400;
const MAX_FAILURES = 20;

/**
 * Group `{ key, text }` entries by key and return the `limit` largest groups,
 * most frequent first, as `"<prefix><count>× <first text seen>"`.
 */
function topGroups(entries, limit, prefix = '') {
    const groups = new Map();
    for (const { key, text } of entries) {
        const g = groups.get(key) ?? { count: 0, example: text };
        g.count++;
        groups.set(key, g);
    }
    return [...groups.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map((g) => `${prefix}${g.count}× ${g.example}`);
}

/**
 * The `limit` most frequent distinct `level=error` messages of a k6 log,
 * prefixed with their count. Messages are grouped by their text up to
 * ". Body:", so the same error with different response bodies counts once;
 * the first body seen is kept as an example. Timestamps, logfmt fields after
 * the message and Go stack tails are dropped; k6's own "thresholds ... have
 * been crossed" line is skipped because the failures already say it.
 */
export function topErrors(logText, limit = 5) {
    const entries = [];
    for (const raw of logText.split('\n')) {
        if (!raw.includes('level=error')) continue;
        if (/thresholds on metrics .* have been crossed/.test(raw)) continue;
        const msg = /msg="((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        const text = msg.replace(/\\n\\tat .*$/, '').slice(0, MAX_LINE);
        entries.push({ key: text.split('. Body:')[0], text });
    }
    return topGroups(entries, limit);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A backend log line's level and message. The backend logs through
 * pino-pretty as `[2026-10-26 07:42:03] WARN: [Context] message` (pid and
 * hostname are not printed), optionally prefixed by `docker compose logs`
 * (`eudiplo-1  | `). The level must directly follow the timestamp at the
 * start of the line, so "ERROR:" inside a message or a continuation line is
 * not mistaken for a level.
 */
export const BACKEND_LINE =
    /^(?:\S+\s+\|\s)?\[[^\]]+\] (TRACE|DEBUG|INFO|WARN|ERROR|FATAL)(?: \([^)]*\))?:\s*(.*)$/;

/** Number of backend log lines per reported level. */
export function countBackendLevels(logText) {
    const counts = { errorOrFatal: 0, warn: 0 };
    for (const raw of logText.split('\n')) {
        const level = BACKEND_LINE.exec(raw)?.[1];
        if (level === 'ERROR' || level === 'FATAL') counts.errorOrFatal++;
        else if (level === 'WARN') counts.warn++;
    }
    return counts;
}

/**
 * The `limit` most frequent distinct WARN/ERROR/FATAL messages of backend log
 * output, prefixed with their count and level. Messages that differ only in
 * UUIDs (session or entity ids) are grouped; the first one seen is the
 * example.
 */
export function topBackendMessages(logText, limit = 5) {
    const entries = [];
    for (const raw of logText.split('\n')) {
        const m = BACKEND_LINE.exec(raw);
        if (!m || !['WARN', 'ERROR', 'FATAL'].includes(m[1])) continue;
        const text = `${m[1]} ${m[2].trim()}`.slice(0, MAX_LINE);
        entries.push({ key: text.replace(UUID, '<id>'), text });
    }
    return topGroups(entries, limit, 'backend ');
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
export function buildAnnotation({ scenario, profile, summary, logText, logName, backendLogText }) {
    const failures = Array.isArray(summary?.failures) ? summary.failures.slice(0, MAX_FAILURES) : [];
    const lines = [...failures, ...topErrors(logText ?? ''), ...topBackendMessages(backendLogText ?? '')];
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

const read = (path) => (path && existsSync(path) ? readFileSync(path, 'utf8') : '');

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--count-backend') {
    const { errorOrFatal, warn } = countBackendLevels(read(process.argv[3]));
    console.log(`Backend log lines during the run: ${errorOrFatal} ERROR/FATAL, ${warn} WARN`);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [scenario, profile, summaryPath, logPath, backendLogPath] = process.argv.slice(2);
    const logText = read(logPath);
    console.log(
        buildAnnotation({
            scenario,
            profile,
            summary: readSummary(summaryPath),
            logText,
            logName: basename(logPath ?? 'k6.log'),
            backendLogText: read(backendLogPath),
        }),
    );
}
