/**
 * End-of-test summary for every scenario.
 *
 * Replaces `--summary-export`, whose JSON also contained `setup_data` (the
 * holder's private key). Writes:
 *
 *   SUMMARY_FILE   JSON with the metrics, thresholds and checks of the run
 *                  (input for compare-baseline.mjs)
 *   SUMMARY_MD     a Markdown report (appended to $GITHUB_STEP_SUMMARY by the
 *                  runner)
 *   SUMMARY_TXT    the compact text table, which is also printed to stdout
 */

import { currentProfile } from '../k6.config.ts';

/** Scenario name for reports: SCENARIO_NAME, set by run-all.sh. */
function scenarioName(): string {
    return __ENV.SCENARIO_NAME || 'scenario';
}

/** A metric in k6's end-of-test summary data. */
interface SummaryMetric {
    type: 'counter' | 'gauge' | 'rate' | 'trend';
    contains: 'default' | 'time' | 'data';
    values: Record<string, number>;
    thresholds?: Record<string, { ok: boolean }>;
}

interface SummaryCheck {
    name: string;
    path: string;
    passes: number;
    fails: number;
}

interface SummaryGroup {
    name: string;
    path: string;
    checks: SummaryCheck[] | Record<string, SummaryCheck>;
    groups: SummaryGroup[] | Record<string, SummaryGroup>;
}

export interface SummaryData {
    metrics: Record<string, SummaryMetric>;
    root_group: SummaryGroup;
    state?: { testRunDurationMs?: number };
    setup_data?: unknown;
    options?: unknown;
}

function values<T>(collection: T[] | Record<string, T> | undefined): T[] {
    if (!collection) return [];
    return Array.isArray(collection) ? collection : Object.values(collection);
}

function allChecks(group: SummaryGroup, out: SummaryCheck[] = []): SummaryCheck[] {
    out.push(...values(group.checks));
    for (const g of values(group.groups)) allChecks(g, out);
    return out;
}

function fmtMs(n: number | undefined): string {
    if (n === undefined || Number.isNaN(n)) return '-';
    return n >= 100 ? `${Math.round(n)}` : n.toFixed(1);
}

function fmtRate(n: number | undefined): string {
    if (n === undefined) return '-';
    return `${(n * 100).toFixed(2)} %`;
}

function fmtNum(n: number | undefined, digits = 1): string {
    if (n === undefined) return '-';
    return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

interface Row {
    metric: string;
    med: string;
    p95: string;
    p99: string;
    max: string;
    count: string;
    status: string;
}

/** Latency rows: every `http_req_duration{...}` sub-metric plus the total. */
function latencyRows(data: SummaryData): Row[] {
    const rows: Row[] = [];
    const names = Object.keys(data.metrics)
        .filter((n) => n.startsWith('http_req_duration') && !n.includes('expected_response'))
        .sort((a, b) => (a === 'http_req_duration' ? -1 : b === 'http_req_duration' ? 1 : a.localeCompare(b)));
    for (const name of names) {
        const m = data.metrics[name];
        rows.push({
            metric: name.replace('http_req_duration', 'latency'),
            med: fmtMs(m.values.med),
            p95: fmtMs(m.values['p(95)']),
            p99: fmtMs(m.values['p(99)']),
            max: fmtMs(m.values.max),
            count: '',
            status: thresholdStatus(m),
        });
    }
    return rows;
}

function thresholdStatus(m: SummaryMetric | undefined): string {
    if (!m?.thresholds) return '';
    const entries = Object.entries(m.thresholds);
    if (entries.length === 0) return '';
    const failed = entries.filter(([, t]) => !t.ok).map(([expr]) => expr);
    return failed.length === 0 ? `ok (${entries.map(([e]) => e).join(', ')})` : `FAILED ${failed.join(', ')}`;
}

export interface SummaryHeadline {
    scenario: string;
    profile: string;
    durationS: number;
    iterations: number;
    iterationRate: number;
    requests: number;
    requestRate: number;
    failedRate: number;
    checksRate: number;
    checksFailed: number;
    droppedIterations: number;
    thresholdsFailed: string[];
}

export function headline(data: SummaryData): SummaryHeadline {
    const m = data.metrics;
    const thresholdsFailed: string[] = [];
    for (const [name, metric] of Object.entries(m)) {
        for (const [expr, t] of Object.entries(metric.thresholds ?? {})) {
            if (!t.ok) thresholdsFailed.push(`${name}: ${expr}`);
        }
    }
    const checks = allChecks(data.root_group);
    return {
        scenario: scenarioName(),
        profile: currentProfile(),
        durationS: (data.state?.testRunDurationMs ?? 0) / 1000,
        iterations: m.iterations?.values.count ?? 0,
        iterationRate: m.iterations?.values.rate ?? 0,
        requests: m.http_reqs?.values.count ?? 0,
        requestRate: m.http_reqs?.values.rate ?? 0,
        failedRate: m.http_req_failed?.values.rate ?? 0,
        checksRate: m.checks?.values.rate ?? 1,
        checksFailed: checks.reduce((n, c) => n + c.fails, 0),
        droppedIterations: m.dropped_iterations?.values.count ?? 0,
        thresholdsFailed,
    };
}

export function markdownSummary(data: SummaryData): string {
    const h = headline(data);
    const verdict = h.thresholdsFailed.length === 0 ? '✅ passed' : '❌ thresholds breached';
    const lines: string[] = [];
    lines.push(`### ${h.scenario} (${h.profile}) — ${verdict}`);
    lines.push('');
    lines.push('| Iterations | Requests | Failed requests | Checks | Dropped iterations | Duration |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    lines.push(
        `| ${h.iterations} (${fmtNum(h.iterationRate)}/s) | ${h.requests} (${fmtNum(h.requestRate)}/s) | ` +
            `${fmtRate(h.failedRate)} | ${fmtRate(h.checksRate)} (${h.checksFailed} failed) | ` +
            `${h.droppedIterations} | ${fmtNum(h.durationS, 0)} s |`,
    );
    lines.push('');
    lines.push('| Metric | med | p95 | p99 | max | Threshold |');
    lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
    for (const r of latencyRows(data)) {
        lines.push(`| \`${r.metric}\` | ${r.med} | ${r.p95} | ${r.p99} | ${r.max} | ${r.status} |`);
    }
    if (h.thresholdsFailed.length > 0) {
        lines.push('');
        lines.push('**Breached thresholds**');
        for (const t of h.thresholdsFailed) lines.push(`- \`${t}\``);
    }
    const failedChecks = allChecks(data.root_group).filter((c) => c.fails > 0);
    if (failedChecks.length > 0) {
        lines.push('');
        lines.push('**Failed checks**');
        for (const c of failedChecks) lines.push(`- \`${c.path}\`: ${c.fails} failed, ${c.passes} passed`);
    }
    lines.push('');
    return lines.join('\n');
}

export function textSummary(data: SummaryData): string {
    const h = headline(data);
    const out: string[] = [];
    out.push('');
    out.push(`  ${h.scenario} / ${h.profile}: ${h.thresholdsFailed.length === 0 ? 'PASSED' : 'THRESHOLDS BREACHED'}`);
    out.push(
        `  iterations ${h.iterations} (${fmtNum(h.iterationRate)}/s)  requests ${h.requests} (${fmtNum(h.requestRate)}/s)  ` +
            `failed ${fmtRate(h.failedRate)}  checks ${fmtRate(h.checksRate)}  dropped ${h.droppedIterations}`,
    );
    out.push('');
    const rows = latencyRows(data);
    const width = Math.max(...rows.map((r) => r.metric.length), 6);
    out.push(`  ${'metric'.padEnd(width)}  ${'med'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)}  threshold`);
    for (const r of rows) {
        out.push(
            `  ${r.metric.padEnd(width)}  ${r.med.padStart(7)} ${r.p95.padStart(7)} ${r.p99.padStart(7)} ${r.max.padStart(7)}  ${r.status}`,
        );
    }
    for (const line of failureLines(data)) out.push(`  ${line}`);
    out.push('');
    return out.join('\n');
}

/**
 * The `handleSummary` export every scenario re-exports. Strips `setup_data`
 * so no key material ends up in the results directory or a CI artifact.
 */
/**
 * What failed in a run, one line each: breached thresholds, then checks
 * with failures. Written into the JSON summary as `failures` for
 * lib/failure-annotation.mjs, and printed by the text summary.
 */
export function failureLines(data: SummaryData): string[] {
    return [
        ...headline(data).thresholdsFailed.map((t) => `✗ ${t}`),
        ...allChecks(data.root_group)
            .filter((c) => c.fails > 0)
            .map((c) => `✗ check ${c.path}: ${c.fails} failed`),
    ];
}

export function handleSummary(data: SummaryData): Record<string, string> {
    const { setup_data: _setup, ...rest } = data;
    const out: Record<string, string> = { stdout: textSummary(data) };
    if (__ENV.SUMMARY_FILE) {
        out[__ENV.SUMMARY_FILE] = JSON.stringify(
            { ...rest, scenario: scenarioName(), profile: currentProfile(), failures: failureLines(data) },
            null,
            2,
        );
    }
    if (__ENV.SUMMARY_MD) {
        out[__ENV.SUMMARY_MD] = markdownSummary(data);
    }
    if (__ENV.SUMMARY_TXT) {
        out[__ENV.SUMMARY_TXT] = out.stdout;
    }
    return out;
}
