import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import http from 'k6/http';
import { envBool, envNumber } from '../lib/helpers.ts';
import { seedSessions } from '../lib/flows/seed.ts';
import { peakUsage, resourceTableMarkdown, toMiB } from '../lib/resource-stats.mjs';

const CLI = fileURLToPath(new URL('../compare-baseline.mjs', import.meta.url));

function summaryFile(dir, name, stages, extra = {}) {
    const metrics = {};
    for (const [stage, p95] of Object.entries(stages)) {
        metrics[`http_req_duration{stage:${stage}}`] = { type: 'trend', values: { 'p(95)': p95 } };
    }
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ scenario: 'flow', profile: 'smoke', metrics, ...extra }));
    return path;
}

function run(args, env = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...env },
    });
}

describe('compare-baseline.mjs exit codes', () => {
    let dir;
    let baseline;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'k6-baseline-'));
        baseline = join(dir, 'baseline.json');
        writeFileSync(baseline, JSON.stringify({ profiles: { smoke: { flow: { p95: { offer: 20 } } } } }));
    });

    test('a regression exits 1 only when enforced', () => {
        const slow = summaryFile(dir, 'slow.json', { offer: 40 });
        assert.equal(run(['--baseline', baseline, slow]).status, 0);
        assert.equal(run(['--baseline', baseline, slow], { BASELINE_ENFORCE: 'true' }).status, 1);
    });

    test('no regression exits 0 even when enforced', () => {
        const ok = summaryFile(dir, 'ok.json', { offer: 21 });
        assert.equal(run(['--baseline', baseline, ok], { BASELINE_ENFORCE: 'true' }).status, 0);
    });

    test('a broken summary, a bad variable or no arguments exit 2', () => {
        const broken = join(dir, 'broken.json');
        writeFileSync(broken, '{"metrics":');
        const noProfile = join(dir, 'noprofile.json');
        writeFileSync(noProfile, JSON.stringify({ metrics: {} }));
        const ok = summaryFile(dir, 'ok.json', { offer: 21 });
        assert.equal(run(['--baseline', baseline, broken]).status, 2);
        assert.equal(run(['--baseline', baseline, noProfile]).status, 2);
        assert.equal(run(['--baseline', baseline, ok], { BASELINE_TOLERANCE: 'abc' }).status, 2);
        assert.equal(run([]).status, 2);
    });

    test('--markdown appends the table, --update writes the p95 values', () => {
        const md = join(dir, 'out.md');
        const fast = summaryFile(dir, 'fast.json', { offer: 12.34, nonce: 3 });
        assert.equal(run(['--baseline', baseline, '--markdown', md, fast]).status, 0);
        assert.match(readFileSync(md, 'utf8'), /\| flow \| smoke \| offer \| 20 \| 12.3 \|/);

        assert.equal(run(['--update', '--baseline', baseline, fast]).status, 0);
        const updated = JSON.parse(readFileSync(baseline, 'utf8'));
        assert.deepEqual(updated.profiles.smoke.flow.p95, { offer: 12.3, nonce: 3 });
    });
});

describe('seedSessions', () => {
    const originalBatch = http.batch;
    let batches;

    beforeEach(() => {
        batches = [];
    });
    afterEach(() => {
        http.batch = originalBatch;
        globalThis.__ENV = {};
    });

    const ctx = { baseUrl: 'http://b', credentialConfigId: 'pid', requestId: 'age-over-18' };

    test('creates the requested sessions in batches, alternating issuance and presentation', () => {
        globalThis.__ENV = { SEED_SESSIONS: '5', SEED_BATCH_SIZE: '2' };
        http.batch = (requests) => {
            batches.push(requests);
            return requests.map(() => ({ status: 201 }));
        };
        seedSessions(ctx, 'token');
        assert.deepEqual(batches.map((b) => b.length), [2, 2, 1]);
        const urls = batches.flat().map((r) => r.url);
        assert.equal(urls.filter((u) => u.endsWith('/api/issuer/offer')).length, 3);
        assert.equal(urls.filter((u) => u.endsWith('/api/verifier/offer')).length, 2);
        assert.equal(batches[0][0].params.tags.stage, 'seed');
        assert.equal(batches[0][0].params.headers.Authorization, 'Bearer token');
    });

    test('more than 1 % failures abort the run', () => {
        globalThis.__ENV = { SEED_SESSIONS: '100', SEED_BATCH_SIZE: '100' };
        http.batch = (requests) => requests.map((_r, i) => ({ status: i < 2 ? 500 : 201 }));
        assert.throws(() => seedSessions(ctx, 't'), /Seeding failed for 2 of 100/);
    });

    test('1 % failures are tolerated', () => {
        globalThis.__ENV = { SEED_SESSIONS: '100', SEED_BATCH_SIZE: '100' };
        http.batch = (requests) => requests.map((_r, i) => ({ status: i < 1 ? 500 : 201 }));
        seedSessions(ctx, 't');
    });

    test('SEED_SESSIONS unset makes no requests', () => {
        globalThis.__ENV = {};
        http.batch = () => assert.fail('no batch expected');
        seedSessions(ctx, 't');
    });
});

describe('env parsing', () => {
    afterEach(() => {
        globalThis.__ENV = {};
    });

    test('envNumber returns the fallback when unset or empty and rejects non-numbers', () => {
        globalThis.__ENV = { A: '', B: '0.25', C: 'abc' };
        assert.equal(envNumber('A', 7), 7);
        assert.equal(envNumber('MISSING', 7), 7);
        assert.equal(envNumber('B', 7), 0.25);
        assert.throws(() => envNumber('C', 7), /C must be a number/);
    });

    test('envBool reads true/false case-insensitively', () => {
        globalThis.__ENV = { T: 'TRUE', F: 'false', E: '' };
        assert.equal(envBool('T', false), true);
        assert.equal(envBool('F', true), false);
        assert.equal(envBool('E', true), true);
    });
});

describe('resource stats', () => {
    test('converts docker units to MiB', () => {
        assert.equal(toMiB('512MiB'), 512);
        assert.equal(toMiB('1.5GiB'), 1536);
        assert.equal(toMiB('1024KiB'), 1);
        assert.equal(Math.round(toMiB('1GB')), 954);
        assert.equal(toMiB('n/a'), 0);
    });

    test('keeps the peak per container and skips malformed lines', () => {
        const peak = peakUsage(
            [
                '{"Name":"eudiplo","CPUPerc":"150.2%","MemUsage":"512MiB / 2GiB"}',
                'garbage',
                '{"Name":"eudiplo","CPUPerc":"90%","MemUsage":"700MiB / 2GiB"}',
                '{"Name":"postgres","CPUPerc":"20%","MemUsage":"100MiB / 1GiB"}',
            ].join('\n'),
        );
        assert.deepEqual(peak.eudiplo, { cpu: 150.2, mem: 700, limit: '2GiB' });
        const md = resourceTableMarkdown(peak);
        assert.match(md, /\| eudiplo \| 150 % \| 700 MiB \| 2GiB \|/);
        assert.equal(resourceTableMarkdown({}), '');
    });
});
