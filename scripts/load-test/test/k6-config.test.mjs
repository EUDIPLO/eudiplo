import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
    mergeThresholds,
    multiScenarioOptions,
    profileThresholds,
    relaxLatencyThresholds,
    scenarioOptions,
    thinkTimeRange,
} from '../k6.config.ts';

function withEnv(env) {
    globalThis.__ENV = { ...env };
}

afterEach(() => withEnv({}));

describe('relaxLatencyThresholds', () => {
    test('multiplies latency bounds and keeps counters and rates', () => {
        const out = relaxLatencyThresholds(
            {
                'http_req_duration{stage:x}': ['p(95)<100', 'p(99)<250'],
                issuance_success: ['count>0'],
                checks: ['rate>0.99'],
            },
            3,
        );
        assert.deepEqual(out['http_req_duration{stage:x}'], ['p(95)<300', 'p(99)<750']);
        assert.deepEqual(out.issuance_success, ['count>0']);
        assert.deepEqual(out.checks, ['rate>0.99']);
    });

    test('factor 1 returns the thresholds unchanged', () => {
        const input = { 'http_req_duration{stage:x}': ['p(95)<100'] };
        assert.deepEqual(relaxLatencyThresholds(input, 1), input);
    });
});

describe('profileThresholds', () => {
    const scenario = {
        'http_req_duration{stage:x}': ['p(95)<100'],
        issuance_success: ['count>0'],
    };

    test('load applies the scenario thresholds and forbids dropped iterations', () => {
        const t = profileThresholds('load', scenario);
        assert.deepEqual(t['http_req_duration{stage:x}'], ['p(95)<100']);
        assert.deepEqual(t.http_req_failed, ['rate<0.01']);
        assert.deepEqual(t.dropped_iterations, ['count==0']);
        assert.deepEqual(t.checks, ['rate>0.99']);
        assert.deepEqual(t.issuance_success, ['count>0']);
    });

    test('stress relaxes latency 3x, accepts 5 % errors and reports dropped iterations only', () => {
        const t = profileThresholds('stress', scenario);
        assert.deepEqual(t['http_req_duration{stage:x}'], ['p(95)<300']);
        assert.deepEqual(t.http_req_failed, ['rate<0.05']);
        assert.equal(t.dropped_iterations, undefined);
        assert.deepEqual(t.issuance_success, ['count>0']);
    });

    test('spike relaxes latency 5x and accepts 10 % errors', () => {
        const t = profileThresholds('spike', scenario);
        assert.deepEqual(t['http_req_duration{stage:x}'], ['p(95)<500']);
        assert.deepEqual(t.http_req_failed, ['rate<0.1']);
    });

    test('once keeps the thresholds without a dropped-iteration rule', () => {
        const t = profileThresholds('once', scenario);
        assert.deepEqual(t['http_req_duration{stage:x}'], ['p(95)<100']);
        assert.equal(t.dropped_iterations, undefined);
    });
});

describe('scenarioOptions', () => {
    const load = { name: 'flow', baseRate: 10, pauses: 1, thresholds: {} };

    test('once runs one iteration', () => {
        withEnv({ K6_PROFILE: 'once' });
        const s = scenarioOptions(load).scenarios.flow;
        assert.equal(s.executor, 'shared-iterations');
        assert.equal(s.iterations, 1);
    });

    test('load ramps an arrival rate to the base rate and down to zero', () => {
        withEnv({ K6_PROFILE: 'load' });
        const s = scenarioOptions(load).scenarios.flow;
        assert.equal(s.executor, 'ramping-arrival-rate');
        assert.deepEqual(
            s.stages.map((st) => st.target),
            [10, 10, 0],
        );
    });

    test('stress peaks at 4x the base rate', () => {
        withEnv({ K6_PROFILE: 'stress' });
        const s = scenarioOptions(load).scenarios.flow;
        assert.equal(Math.max(...s.stages.map((st) => st.target)), 40);
    });

    test('the VU pool grows with think time', () => {
        withEnv({ K6_PROFILE: 'load', THINK_TIME_MIN: '0', THINK_TIME_MAX: '0' });
        const without = scenarioOptions(load).scenarios.flow;
        withEnv({ K6_PROFILE: 'load', THINK_TIME_MIN: '5', THINK_TIME_MAX: '10' });
        const withThink = scenarioOptions(load).scenarios.flow;
        assert.ok(withThink.preAllocatedVUs > without.preAllocatedVUs);
        // 10/s × (0.25 s + 10 s) ≈ 103 busy VUs; pre-allocated 1.5×, max 4×.
        assert.equal(withThink.preAllocatedVUs, 154);
        assert.equal(withThink.maxVUs, 410);
    });

    test('an unknown profile is rejected', () => {
        withEnv({ K6_PROFILE: 'soak' });
        assert.throws(() => scenarioOptions(load), /Unknown K6_PROFILE "soak"/);
    });
});

describe('multiScenarioOptions', () => {
    test('creates one k6 scenario per flow and merges their thresholds', () => {
        withEnv({ K6_PROFILE: 'smoke' });
        const o = multiScenarioOptions([
            { name: 'a', exec: 'a', baseRate: 10, thresholds: { 'http_req_duration{stage:a}': ['p(95)<10'] } },
            { name: 'b', exec: 'b', baseRate: 100, thresholds: { 'http_req_duration{stage:b}': ['p(95)<20'] } },
        ]);
        assert.deepEqual(Object.keys(o.scenarios), ['a', 'b']);
        assert.equal(o.scenarios.a.exec, 'a');
        assert.equal(o.scenarios.b.rate, 10);
        assert.ok(o.thresholds['http_req_duration{stage:a}']);
        assert.ok(o.thresholds['http_req_duration{stage:b}']);
    });
});

describe('thinkTimeRange', () => {
    test('defaults per profile', () => {
        withEnv({ K6_PROFILE: 'smoke' });
        assert.deepEqual(thinkTimeRange(), { min: 0, max: 0 });
        withEnv({ K6_PROFILE: 'load' });
        assert.deepEqual(thinkTimeRange(), { min: 1, max: 5 });
        withEnv({ K6_PROFILE: 'spike' });
        assert.deepEqual(thinkTimeRange(), { min: 0, max: 1 });
    });

    test('a max below min is raised to min', () => {
        withEnv({ K6_PROFILE: 'load', THINK_TIME_MIN: '3', THINK_TIME_MAX: '1' });
        assert.deepEqual(thinkTimeRange(), { min: 3, max: 3 });
    });
});

describe('mergeThresholds', () => {
    test('keeps the expressions of both flows for a shared metric', () => {
        const merged = mergeThresholds(
            { 'http_req_duration{stage:token}': ['p(95)<200'], checks: ['rate>0.99'] },
            { 'http_req_duration{stage:token}': ['p(99)<400'], checks: ['rate>0.99'] },
        );
        assert.deepEqual(merged['http_req_duration{stage:token}'], ['p(95)<200', 'p(99)<400']);
        assert.deepEqual(merged.checks, ['rate>0.99']);
    });
});

describe('think time validation', () => {
    test('a non-numeric value is rejected', () => {
        withEnv({ K6_PROFILE: 'load', THINK_TIME_MAX: 'five' });
        assert.throws(() => thinkTimeRange(), /THINK_TIME_MAX must be a non-negative number/);
    });
});
