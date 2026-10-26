/**
 * Shared k6 options/profiles for EUDIPLO load tests.
 *
 * Every scenario describes its workload once — the iteration rate it should
 * sustain under the `load` profile and the SLO thresholds that rate has to
 * meet — and `scenarioOptions()` turns that into the k6 options for the
 * profile named in `K6_PROFILE`:
 *
 *   import { scenarioOptions } from '../k6.config';
 *   export const options = scenarioOptions({
 *       name: 'issuance',
 *       baseRate: 10,          // iterations per second under `load`
 *       thresholds: { 'http_req_duration{stage:credential}': ['p(95)<150'] },
 *   });
 *
 * Profiles use k6's open-model executors (`*-arrival-rate`): the load is
 * stated as a request rate and does not back off when the backend slows
 * down, so queueing shows up as latency and `dropped_iterations` instead of
 * silently reducing throughput as a VU loop would.
 *
 *   once    one iteration with one VU (fast end-to-end validation)
 *   smoke   10 % of the base rate for 1 minute
 *   load    ramp to the base rate, hold 5 minutes
 *   stress  ramp to 4× the base rate to find the breaking point
 *   spike   sudden 10× burst to verify recovery
 *
 * The scenario's thresholds apply as written to `once`, `smoke` and `load`.
 * `stress` and `spike` relax the latency thresholds by a factor and accept a
 * higher error rate, so a run still reports where the system breaks instead
 * of failing on the first slow percentile.
 */

import type { Options, Scenario } from 'k6/options';

export type Profile = 'once' | 'smoke' | 'load' | 'stress' | 'spike';

/** How a scenario behaves under load. */
export interface ScenarioLoad {
    /** Name of the k6 scenario; `exec` defaults to `default`. */
    name: string;
    /** Exported function to run; omit for the module's default export. */
    exec?: string;
    /** Iterations per second to sustain under the `load` profile. */
    baseRate: number;
    /**
     * Number of think-time pauses in one iteration (see `thinkTimeRange`).
     * Used to size the VU pool: with arrival-rate executors the number of
     * concurrently busy VUs is rate × iteration duration, and a pool that is
     * too small makes k6 start VUs mid-run and drop iterations.
     */
    pauses?: number;
    /**
     * Expected time one iteration spends in requests, in seconds, excluding
     * think time (default 0.25). Together with `pauses` it sizes the VU pool.
     */
    requestSeconds?: number;
    /** Override for the VU upper bound computed from rate and pauses. */
    maxVUs?: number;
    /**
     * SLO thresholds for the scenario under the `load` profile. Latency
     * thresholds are relaxed for `stress` and `spike`; counters and the
     * `checks` rate are applied unchanged.
     */
    thresholds: Record<string, string[]>;
}

/** Per-profile shape of the workload. */
interface ProfileShape {
    /** Factor applied to every latency threshold value. */
    latencyFactor: number;
    /** Accepted `http_req_failed` rate. */
    maxFailedRate: number;
    /** Whether `dropped_iterations` must stay at zero. */
    enforceNoDroppedIterations: boolean;
    build(load: ScenarioLoad): Scenario;
}

const DEFAULT_THRESHOLDS: Record<string, string[]> = {
    /** Every check in the flow must pass. */
    checks: ['rate>0.99'],
};

function arrivalStages(
    baseRate: number,
    stages: Array<{ duration: string; factor: number }>,
) {
    return stages.map((s) => ({
        duration: s.duration,
        target: s.factor === 0 ? 0 : Math.max(1, Math.round(baseRate * s.factor)),
    }));
}

/**
 * Size the VU pool for an arrival-rate executor. Busy VUs ≈ rate × iteration
 * seconds (Little's law). The iteration estimate is the flow's request time
 * plus the worst-case think time; the pool is pre-allocated for 1.5× that at
 * the peak rate so k6 does not start VUs mid-run, and may grow to 4× — when
 * that is not enough, requests take 4× longer than expected, the backend is
 * the bottleneck, and `dropped_iterations` reports it.
 */
function vuBounds(load: ScenarioLoad, peakFactor: number) {
    const think = thinkTimeRange();
    const iterationSeconds = (load.requestSeconds ?? 0.25) + (load.pauses ?? 0) * think.max;
    const busy = Math.max(1, load.baseRate * peakFactor * iterationSeconds);
    const preAllocatedVUs = Math.max(5, Math.ceil(busy * 1.5));
    const maxVUs = load.maxVUs ?? Math.max(20, preAllocatedVUs, Math.ceil(busy * 4));
    return { preAllocatedVUs: Math.min(preAllocatedVUs, maxVUs), maxVUs };
}

const PROFILES: Record<Profile, ProfileShape> = {
    once: {
        latencyFactor: 1,
        maxFailedRate: 0.01,
        enforceNoDroppedIterations: false,
        build: () => ({
            executor: 'shared-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '2m',
        }),
    },
    smoke: {
        latencyFactor: 1,
        maxFailedRate: 0.01,
        enforceNoDroppedIterations: true,
        build: (load) => ({
            executor: 'constant-arrival-rate',
            rate: Math.max(1, Math.round(load.baseRate / 10)),
            timeUnit: '1s',
            duration: '1m',
            ...vuBounds(load, 0.2),
        }),
    },
    load: {
        latencyFactor: 1,
        maxFailedRate: 0.01,
        enforceNoDroppedIterations: true,
        build: (load) => ({
            executor: 'ramping-arrival-rate',
            startRate: Math.max(1, Math.round(load.baseRate / 10)),
            timeUnit: '1s',
            stages: arrivalStages(load.baseRate, [
                { duration: '1m', factor: 1 },
                { duration: '5m', factor: 1 },
                { duration: '30s', factor: 0 },
            ]),
            ...vuBounds(load, 1),
        }),
    },
    stress: {
        latencyFactor: 3,
        maxFailedRate: 0.05,
        // Dropped iterations are the signal we are looking for here; they are
        // reported, not enforced.
        enforceNoDroppedIterations: false,
        build: (load) => ({
            executor: 'ramping-arrival-rate',
            startRate: Math.max(1, Math.round(load.baseRate / 10)),
            timeUnit: '1s',
            stages: arrivalStages(load.baseRate, [
                { duration: '1m', factor: 1 },
                { duration: '2m', factor: 2 },
                { duration: '2m', factor: 4 },
                { duration: '2m', factor: 4 },
                { duration: '1m', factor: 0 },
            ]),
            ...vuBounds(load, 4),
        }),
    },
    spike: {
        latencyFactor: 5,
        maxFailedRate: 0.1,
        enforceNoDroppedIterations: false,
        build: (load) => ({
            executor: 'ramping-arrival-rate',
            startRate: Math.max(1, Math.round(load.baseRate / 5)),
            timeUnit: '1s',
            stages: arrivalStages(load.baseRate, [
                { duration: '30s', factor: 0.2 },
                { duration: '10s', factor: 10 }, // spike
                { duration: '1m', factor: 10 },
                { duration: '10s', factor: 0.2 }, // recover
                { duration: '30s', factor: 0 },
            ]),
            ...vuBounds(load, 10),
        }),
    },
};

/** The profile named in `K6_PROFILE` (default `smoke`). */
export function currentProfile(): Profile {
    const profile = (__ENV.K6_PROFILE || 'smoke').toLowerCase();
    if (!(profile in PROFILES)) {
        throw new Error(
            `Unknown K6_PROFILE "${profile}". Choose: ${Object.keys(PROFILES).join(', ')}`,
        );
    }
    return profile as Profile;
}

/**
 * Multiply the numeric bound of latency threshold expressions such as
 * `p(95)<150` by `factor`. Non-latency metrics (counters, rates) are left
 * unchanged.
 */
export function relaxLatencyThresholds(
    thresholds: Record<string, string[]>,
    factor: number,
): Record<string, string[]> {
    if (factor === 1) return { ...thresholds };
    const out: Record<string, string[]> = {};
    for (const [metric, exprs] of Object.entries(thresholds)) {
        const isLatency = /duration/.test(metric);
        out[metric] = exprs.map((expr) => {
            if (!isLatency) return expr;
            return expr.replace(/([<>]=?)\s*(\d+(?:\.\d+)?)/, (_m, op, num) => {
                return `${op}${Math.round(Number(num) * factor)}`;
            });
        });
    }
    return out;
}

/** Thresholds for one scenario under one profile. */
export function profileThresholds(
    profile: Profile,
    thresholds: Record<string, string[]>,
): Record<string, string[]> {
    const shape = PROFILES[profile];
    const merged = {
        ...DEFAULT_THRESHOLDS,
        ...relaxLatencyThresholds(thresholds, shape.latencyFactor),
        http_req_failed: [`rate<${shape.maxFailedRate}`],
    };
    if (shape.enforceNoDroppedIterations) {
        merged.dropped_iterations = ['count==0'];
    }
    return merged;
}

/** Options shared by every run, independent of profile and scenario. */
const BASE_OPTIONS: Options = {
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    // setup() issues the credential pool and may seed SEED_SESSIONS sessions.
    setupTimeout: __ENV.K6_SETUP_TIMEOUT || '15m',
};

/**
 * k6 options for a single-flow scenario under the profile in `K6_PROFILE`.
 */
export function scenarioOptions(load: ScenarioLoad): Options {
    return multiScenarioOptions([load]);
}

/**
 * k6 options for several flows that run concurrently (a mixed workload).
 * Each flow needs an `exec` export; thresholds of all flows are merged.
 */
export function multiScenarioOptions(loads: ScenarioLoad[]): Options {
    const profile = currentProfile();
    const shape = PROFILES[profile];
    const scenarios: Record<string, Scenario> = {};
    let thresholds: Record<string, string[]> = {};
    for (const load of loads) {
        scenarios[load.name] = {
            ...shape.build(load),
            exec: load.exec,
            gracefulStop: '30s',
        };
        thresholds = mergeThresholds(thresholds, profileThresholds(profile, load.thresholds));
    }
    return { ...BASE_OPTIONS, scenarios, thresholds };
}

/**
 * Merge threshold maps. When two flows name the same metric, both sets of
 * expressions apply (k6 evaluates every expression), instead of the later
 * flow silently replacing the earlier one.
 */
export function mergeThresholds(
    a: Record<string, string[]>,
    b: Record<string, string[]>,
): Record<string, string[]> {
    const out: Record<string, string[]> = { ...a };
    for (const [metric, exprs] of Object.entries(b)) {
        out[metric] = [...new Set([...(out[metric] ?? []), ...exprs])];
    }
    return out;
}

/** Seconds of simulated user think time for the current profile. */
export function thinkTimeRange(): { min: number; max: number } {
    const profile = currentProfile();
    // once/smoke: none, for fast feedback. spike: short, the burst of
    // arrivals is the point. load/stress: a user scanning a QR code.
    const defaults: Record<Profile, [number, number]> = {
        once: [0, 0],
        smoke: [0, 0],
        load: [1, 5],
        stress: [1, 5],
        spike: [0, 1],
    };
    const [defaultMin, defaultMax] = defaults[profile];
    const min = seconds('THINK_TIME_MIN', defaultMin);
    const max = seconds('THINK_TIME_MAX', defaultMax);
    return { min, max: Math.max(min, max) };
}

function seconds(name: string, fallback: number): number {
    const raw = __ENV[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${name} must be a non-negative number of seconds, got "${raw}"`);
    }
    return n;
}
