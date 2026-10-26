import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { compareSummaries, stageP95, updateBaseline } from '../lib/baseline.mjs';
import { handleSummary, observed } from '../lib/summary.ts';

afterEach(() => {
    globalThis.__ENV = {};
});

function trend(p95) {
    return { type: 'trend', contains: 'time', values: { med: p95 / 2, 'p(95)': p95, 'p(99)': p95, max: p95 } };
}

function summary({ scenario = 'flow', profile = 'smoke', stages = {}, extra = {} } = {}) {
    const metrics = {
        iterations: { type: 'counter', contains: 'default', values: { count: 10, rate: 1 } },
        http_reqs: { type: 'counter', contains: 'default', values: { count: 20, rate: 2 } },
        http_req_failed: { type: 'rate', contains: 'default', values: { rate: 0 } },
        ...extra,
    };
    for (const [stage, p95] of Object.entries(stages)) {
        metrics[`http_req_duration{stage:${stage}}`] = trend(p95);
    }
    return { scenario, profile, metrics, root_group: { name: '', path: '', checks: [], groups: [] } };
}

describe('handleSummary', () => {
    test('writes JSON without setup data but with scenario and profile', () => {
        globalThis.__ENV = { SUMMARY_FILE: '/out.json', SCENARIO_NAME: 'flow', K6_PROFILE: 'load' };
        const data = {
            ...summary(),
            setup_data: { holder: { privateJwk: { d: 'secret' } }, adminToken: { token: 't' } },
        };
        const out = handleSummary(data);
        const json = JSON.parse(out['/out.json']);
        assert.equal(json.setup_data, undefined);
        assert.ok(!out['/out.json'].includes('secret'));
        assert.equal(json.scenario, 'flow');
        assert.equal(json.profile, 'load');
        assert.ok(out.stdout.includes('flow / load'));
    });

    test('lists failed checks from nested groups in record form', () => {
        globalThis.__ENV = { SUMMARY_MD: '/out.md', SCENARIO_NAME: 'flow', K6_PROFILE: 'smoke' };
        const data = summary();
        data.root_group = {
            name: '',
            path: '',
            checks: {},
            groups: {
                credential: {
                    name: 'credential',
                    path: '::credential',
                    checks: { ok: { name: 'ok', path: '::credential::status 200', passes: 9, fails: 1 } },
                    groups: {},
                },
            },
        };
        const out = handleSummary(data);
        assert.match(out['/out.md'], /\*\*Failed checks\*\*/);
        assert.match(out['/out.md'], /::credential::status 200`: 1 failed, 9 passed/);
        assert.match(out.stdout, /✗ check ::credential::status 200: 1 failed/);
    });

    test('records what failed in the JSON summary, for array and record groups', () => {
        globalThis.__ENV = { SUMMARY_FILE: '/out.json', SCENARIO_NAME: 'flow', K6_PROFILE: 'smoke' };
        const data = summary({ stages: { credential: 400 } });
        data.metrics['http_req_duration{stage:credential}'].thresholds = {
            'p(95)<250': { ok: false },
            'p(99)<500': { ok: true },
        };
        data.root_group = {
            name: '',
            path: '',
            checks: [{ name: 'ok', path: '::ok', passes: 3, fails: 0 }],
            groups: [
                {
                    name: 'a',
                    path: '::a',
                    checks: [{ name: 's', path: '::a::status 200', passes: 1, fails: 2 }],
                    groups: { b: { name: 'b', path: '::a::b', checks: { c: { name: 'c', path: '::a::b::body', passes: 0, fails: 1 } }, groups: {} } },
                },
            ],
        };
        const json = JSON.parse(handleSummary(data)['/out.json']);
        assert.deepEqual(json.failures, [
            '✗ http_req_duration{stage:credential}: p(95)<250 (observed p(95)=400)',
            '✗ check ::a::status 200: 2 failed',
            '✗ check ::a::b::body: 1 failed',
        ]);
    });

    test('reports breached thresholds in the Markdown summary', () => {
        globalThis.__ENV = { SUMMARY_MD: '/out.md', SCENARIO_NAME: 'flow', K6_PROFILE: 'smoke' };
        const data = summary({ stages: { credential: 400 } });
        data.metrics['http_req_duration{stage:credential}'].thresholds = { 'p(95)<250': { ok: false } };
        const out = handleSummary(data);
        const md = out['/out.md'];
        assert.match(out.stdout, /✗ http_req_duration\{stage:credential\}: p\(95\)<250/);
        assert.match(md, /thresholds breached/);
        assert.match(md, /http_req_duration\{stage:credential\}: p\(95\)<250/);
    });
});

describe('stageP95', () => {
    test('ignores setup, seed, token refresh and stages that never ran', () => {
        const p = stageP95(summary({ stages: { offer: 12.34, setup: 50, seed: 9, token_refresh: 40, nonce: 0 } }));
        assert.deepEqual(p, { offer: 12.3 });
    });
});

describe('compareSummaries', () => {
    const baseline = { profiles: { smoke: { flow: { p95: { slow: 40, tiny: 2, same: 10 } } } } };

    test('a stage more than 20 % and more than 5 ms slower regresses', () => {
        const r = compareSummaries(baseline, [summary({ stages: { slow: 50 } })]);
        assert.equal(r.regressions, 1);
    });

    test('a large relative increase of a few ms does not regress', () => {
        const r = compareSummaries(baseline, [summary({ stages: { tiny: 5 } })]);
        assert.equal(r.regressions, 0);
    });

    test('tolerance and minimum are configurable', () => {
        const r = compareSummaries(baseline, [summary({ stages: { tiny: 5 } })], { tolerance: 0.2, minMs: 0 });
        assert.equal(r.regressions, 1);
    });

    test('a baseline stage the run did not reach is reported, not counted', () => {
        const r = compareSummaries(baseline, [summary({ stages: { same: 10 } })]);
        assert.equal(r.regressions, 0);
        const missing = r.rows.filter((row) => row.delta === 'missing').map((row) => row.stage);
        assert.deepEqual(missing.sort(), ['slow', 'tiny']);
    });

    test('a stage without baseline is reported as new, not counted', () => {
        const r = compareSummaries(baseline, [summary({ stages: { same: 10, fresh: 999 } })]);
        assert.equal(r.regressions, 0);
        assert.equal(r.rows.find((row) => row.stage === 'fresh').delta, 'new stage');
    });

    test('a missing baseline is reported, not compared', () => {
        const r = compareSummaries({ profiles: {} }, [summary({ stages: { slow: 500 } })]);
        assert.equal(r.regressions, 0);
        assert.equal(r.rows[0].delta, 'no baseline');
    });

    test('a summary without scenario/profile is rejected', () => {
        assert.throws(() => compareSummaries(baseline, [{ metrics: {} }]), /missing scenario\/profile/);
    });
});

describe('updateBaseline', () => {
    test('replaces only the given profile and scenario', () => {
        const before = {
            $comment: 'keep',
            profiles: { load: { flow: { p95: { offer: 1 } } }, smoke: { other: { p95: { x: 2 } } } },
        };
        const after = updateBaseline(before, [summary({ stages: { offer: 7 } })]);
        assert.equal(after.$comment, 'keep');
        assert.deepEqual(after.profiles.smoke.flow.p95, { offer: 7 });
        assert.deepEqual(after.profiles.smoke.other.p95, { x: 2 });
        assert.deepEqual(after.profiles.load.flow.p95, { offer: 1 });
        assert.deepEqual(before.profiles.smoke.flow, undefined, 'input is not mutated');
    });
});

describe('observed', () => {
    test('names the measured value of the threshold statistic', () => {
        const metric = { type: 'trend', contains: 'time', values: { 'p(95)': 73.44, 'p(99)': 120 } };
        assert.equal(observed(metric, 'p(95)<50'), ' (observed p(95)=73.4)');
        assert.equal(observed(metric, 'p(99)<100'), ' (observed p(99)=120)');
        assert.equal(observed({ values: { 'p(99.9)': 812.3 } }, 'p(99.9)<500'), ' (observed p(99.9)=812.3)');
        assert.equal(observed({ values: { rate: 0.0312 } }, 'rate<0.01'), ' (observed rate=0.0312)');
        assert.equal(observed({ values: { count: 0 } }, 'count>0'), ' (observed count=0)');
    });

    test('adds nothing when the statistic is missing or not a number', () => {
        assert.equal(observed({ values: {} }, 'p(95)<50'), '');
        assert.equal(observed({ values: { 'p(95)': NaN } }, 'p(95)<50'), '');
    });

    test('adds nothing when the expression names no statistic', () => {
        assert.equal(observed({ values: { 'p(95)': 1 } }, '<50'), '');
    });
});
