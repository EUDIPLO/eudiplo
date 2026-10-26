/**
 * Pure functions behind compare-baseline.mjs: extract per-stage p95 values
 * from k6 summaries (written by lib/summary.ts) and compare them with the
 * committed baseline.
 */

const STAGE_METRIC = /^http_req_duration\{stage:([^}]+)\}$/;

/** Stages that are not part of the measured flows. */
const IGNORED_STAGES = new Set(['setup', 'seed', 'token_refresh']);

/** p95 per stage from one summary, skipping setup/seed and empty stages. */
export function stageP95(summary) {
    const out = {};
    for (const [name, metric] of Object.entries(summary.metrics ?? {})) {
        const m = STAGE_METRIC.exec(name);
        if (!m || IGNORED_STAGES.has(m[1])) continue;
        const p95 = metric.values?.['p(95)'];
        // A stage that never ran reports 0 — no data, not a fast stage.
        if (typeof p95 === 'number' && p95 > 0) out[m[1]] = Math.round(p95 * 10) / 10;
    }
    return out;
}

/** Throw unless the summary names its scenario and profile. */
export function assertSummary(summary, source = 'summary') {
    if (!summary || typeof summary !== 'object' || !summary.scenario || !summary.profile) {
        throw new Error(`${source}: missing scenario/profile (written by lib/summary.ts?)`);
    }
}

/**
 * Return a new baseline with the p95 values of `summaries`. Only the
 * profile/scenario pairs present in `summaries` are replaced.
 */
export function updateBaseline(baseline, summaries) {
    const next = structuredClone(baseline ?? {});
    next.profiles ??= {};
    for (const s of summaries) {
        assertSummary(s);
        next.profiles[s.profile] ??= {};
        next.profiles[s.profile][s.scenario] = { p95: stageP95(s) };
    }
    return next;
}

/**
 * Compare summaries with the baseline. A stage regresses when its p95 is
 * more than `tolerance` (a fraction) and more than `minMs` above the
 * baseline.
 */
export function compareSummaries(baseline, summaries, { tolerance = 0.2, minMs = 5 } = {}) {
    const rows = [];
    let regressions = 0;
    for (const s of summaries) {
        assertSummary(s);
        const expected = baseline?.profiles?.[s.profile]?.[s.scenario]?.p95;
        if (!expected) {
            rows.push({ scenario: s.scenario, profile: s.profile, stage: '*', base: '-', now: '-', delta: 'no baseline', status: 'ℹ️' });
            continue;
        }
        const actual = stageP95(s);
        // A baseline stage the run never reached: the flow changed or broke.
        for (const stage of Object.keys(expected)) {
            if (!(stage in actual)) {
                rows.push({ scenario: s.scenario, profile: s.profile, stage, base: expected[stage], now: '-', delta: 'missing', status: '⚠️ not measured' });
            }
        }
        for (const [stage, now] of Object.entries(actual)) {
            const base = expected[stage];
            if (base === undefined) {
                rows.push({ scenario: s.scenario, profile: s.profile, stage, base: '-', now, delta: 'new stage', status: 'ℹ️' });
                continue;
            }
            const diff = now - base;
            const ratio = base > 0 ? diff / base : 0;
            const regressed = ratio > tolerance && diff > minMs;
            if (regressed) regressions++;
            rows.push({
                scenario: s.scenario,
                profile: s.profile,
                stage,
                base,
                now,
                delta: `${diff >= 0 ? '+' : ''}${(ratio * 100).toFixed(0)} %`,
                status: regressed ? '⚠️ regression' : '✅',
                regressed,
            });
        }
    }
    return { rows, regressions };
}

/** Markdown table for `compareSummaries` rows. */
export function comparisonMarkdown({ rows }, { tolerance = 0.2, minMs = 5 } = {}) {
    return [
        `#### p95 latency vs. baseline (tolerance +${Math.round(tolerance * 100)} %, more than ${minMs} ms)`,
        '',
        '| Scenario | Profile | Stage | Baseline p95 (ms) | p95 (ms) | Δ | |',
        '| --- | --- | --- | ---: | ---: | ---: | --- |',
        ...rows.map((r) => `| ${r.scenario} | ${r.profile} | ${r.stage} | ${r.base} | ${r.now} | ${r.delta} | ${r.status} |`),
        '',
    ].join('\n');
}
