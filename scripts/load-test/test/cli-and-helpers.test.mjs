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
import {
    buildAnnotation,
    escapeCommandMessage,
    countBackendLevels,
    escapeCommandProperty,
    topBackendMessages,
    topErrors,
} from '../lib/failure-annotation.mjs';

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

describe('failure annotation', () => {
    const ANNOTATE = fileURLToPath(new URL('../lib/failure-annotation.mjs', import.meta.url));
    // The shape k6 v2 logs for an uncaught fail() inside an iteration.
    const k6Error = (msg) =>
        `time="2026-10-26T07:00:00Z" level=error msg="Uncaught (in promise) GoError: ${msg}\\n\\tat go.k6.io/k6/v2/internal/js/modules/k6.(*K6).Fail-fm (native)\\n\\tat default (file:///s.ts:1:1)" executor=ramping-arrival-rate scenario=flow source=stacktrace`;

    test('groups errors by message without the response body, most frequent first', () => {
        const log = [
            k6Error('credential: unexpected status 500. Body: {\\"id\\":\\"a\\"}'),
            k6Error('credential: unexpected status 500. Body: {\\"id\\":\\"b\\"}'),
            k6Error('revoke: unexpected status 404. Body: {}'),
            `time="2026-10-26T07:00:03Z" level=error msg="thresholds on metrics 'checks' have been crossed"`,
            `time="2026-10-26T07:00:04Z" level=info msg="Seeded 10 sessions" source=console`,
        ].join('\n');
        assert.deepEqual(topErrors(log), [
            '2× Uncaught (in promise) GoError: credential: unexpected status 500. Body: {\\"id\\":\\"a\\"}',
            '1× Uncaught (in promise) GoError: revoke: unexpected status 404. Body: {}',
        ]);
    });

    test('keeps at most `limit` groups and cuts long messages', () => {
        const log = Array.from({ length: 7 }, (_v, i) => k6Error(`error ${i} ${'x'.repeat(1000)}`)).join('\n');
        const errors = topErrors(log);
        assert.equal(errors.length, 5);
        for (const e of errors) assert.ok(e.replace(/^\d+× /, '').length <= 400);
    });

    test('escapes % before line breaks, and : and , in the title', () => {
        assert.equal(escapeCommandMessage('50% done\nnext\r'), '50%25 done%0Anext%0D');
        assert.equal(escapeCommandProperty('a:b,c%\n'), 'a%3Ab%2Cc%25%0A');
    });

    test('uses the failures recorded in the summary, capped at 20', () => {
        const failures = Array.from({ length: 25 }, (_v, i) => `✗ check ::c${i}: 1 failed`);
        const line = buildAnnotation({ scenario: 'mixed', profile: 'smoke', summary: { failures }, logText: '', logName: 'x.log' });
        assert.match(line, /^::error title=k6 mixed \(smoke\) failed::✗ check ::c0: 1 failed%0A/);
        assert.equal(line.split('%0A').length, 20);
        assert.equal(line.split('\n').length, 1);
    });

    // The backend's pino-pretty format, as `docker compose logs` prints it.
    const backendLine = (level, msg) => `eudiplo-1  | [2026-10-26 07:42:03] ${level}: ${msg}`;

    test('groups backend messages that differ only in ids, most frequent first', () => {
        const log = [
            backendLine('ERROR', '[Oid4vpService] Presentation failed'),
            backendLine('WARN', '[CredentialChainValidationService] Status list chain validation failed for TrustedEntity 11111111-2222-3333-4444-555555555555: no trusted entity matched'),
            backendLine('WARN', '[CredentialChainValidationService] Status list chain validation failed for TrustedEntity 66666666-7777-8888-9999-000000000000: no trusted entity matched'),
            'eudiplo-1  |     sessionId: "abc"',
            'eudiplo-1  |     error: "ERROR: upstream refused"',
            backendLine('INFO', '[Http] upstream said ERROR: nope'),
            backendLine('INFO', '[Http] ERROR: nope'),
            'eudiplo-1  |     message: "[x] WARN: y"',
            backendLine('FATAL', '[Bootstrap] out of memory'),
        ].join('\n');
        assert.deepEqual(countBackendLevels(log), { errorOrFatal: 2, warn: 2 });
        assert.deepEqual(topBackendMessages(log), [
            'backend 2× WARN [CredentialChainValidationService] Status list chain validation failed for TrustedEntity 11111111-2222-3333-4444-555555555555: no trusted entity matched',
            'backend 1× ERROR [Oid4vpService] Presentation failed',
            'backend 1× FATAL [Bootstrap] out of memory',
        ]);
    });

    test('also reads the header with a pid, and keeps at most `limit` groups', () => {
        assert.deepEqual(topBackendMessages('[2026-10-26 07:42:03] WARN (17): [X] y'), ['backend 1× WARN [X] y']);
        assert.deepEqual(topBackendMessages('[2026-10-26 07:42:03] WARN: [X] y'), ['backend 1× WARN [X] y']);
        const many = Array.from({ length: 7 }, (_v, i) => backendLine('WARN', `[X] message ${i}`)).join('\n');
        assert.equal(topBackendMessages(many).length, 5);
    });

    test('orders failures, then k6 errors, then backend messages, then an unreadable summary', () => {
        const line = buildAnnotation({
            scenario: 's',
            profile: 'smoke',
            summary: { failures: ['✗ checks: rate>0.99'] },
            logText: k6Error('credential: unexpected status 500. Body: x'),
            logName: 'k6.log',
            backendLogText: backendLine('WARN', '[X] boom'),
        });
        const parts = line.split('::').pop().split('%0A');
        assert.equal(parts.length, 3);
        assert.equal(parts[0], '✗ checks: rate>0.99');
        assert.match(parts[1], /^1× Uncaught \(in promise\) GoError: credential: unexpected status 500/);
        assert.equal(parts[2], 'backend 1× WARN [X] boom');

        const unreadable = buildAnnotation({ scenario: 's', profile: 'smoke', summary: 'Summary s.json is unreadable: x', logText: '', logName: 'k6.log', backendLogText: backendLine('ERROR', '[Y] z') });
        assert.match(unreadable, /backend 1× ERROR \[Y\] z%0ASummary s\.json is unreadable: x$/);
    });

    function cli(args) {
        return spawnSync(process.execPath, [ANNOTATE, ...args], { encoding: 'utf8' });
    }

    test('CLI: missing summary and log give the fallback message', () => {
        const dir = mkdtempSync(join(tmpdir(), 'k6-annot-'));
        const r = cli(['mixed', 'smoke', join(dir, 'missing.json'), join(dir, 'k6.log')]);
        assert.equal(r.status, 0);
        assert.match(r.stdout.trim(), /^::error title=k6 mixed \(smoke\) failed::k6 exited with an error; see k6\.log in the artifact\.$/);
    });

    test('CLI: an unreadable summary is named, the log errors still appear', () => {
        const dir = mkdtempSync(join(tmpdir(), 'k6-annot-'));
        const summaryPath = join(dir, 's.json');
        const logPath = join(dir, 'k6.log');
        writeFileSync(summaryPath, '{not json');
        writeFileSync(logPath, k6Error('nonce endpoint: unexpected status 503. Body: down'));
        const r = cli(['flow', 'load', summaryPath, logPath]);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /1× Uncaught \(in promise\) GoError: nonce endpoint: unexpected status 503/);
        assert.match(r.stdout, /Summary s\.json is unreadable/);
    });

    test('CLI: reads the backend log from the fifth argument and ignores a missing one', () => {
        const dir = mkdtempSync(join(tmpdir(), 'k6-annot-'));
        const summaryPath = join(dir, 's.json');
        const backendPath = join(dir, 'backend.log');
        writeFileSync(summaryPath, JSON.stringify({ failures: ['✗ checks: rate>0.99'] }));
        writeFileSync(backendPath, backendLine('ERROR', '[X] boom'));
        const withBackend = cli(['flow', 'load', summaryPath, join(dir, 'none.log'), backendPath]);
        assert.equal(withBackend.stdout.trim(), '::error title=k6 flow (load) failed::✗ checks: rate>0.99%0Abackend 1× ERROR [X] boom');
        const missing = cli(['flow', 'load', summaryPath, join(dir, 'none.log'), join(dir, 'missing.log')]);
        assert.equal(missing.stdout.trim(), '::error title=k6 flow (load) failed::✗ checks: rate>0.99');
    });

    test('CLI: --count-backend prints the level counts', () => {
        const dir = mkdtempSync(join(tmpdir(), 'k6-annot-'));
        const backendPath = join(dir, 'backend.log');
        writeFileSync(backendPath, [backendLine('ERROR', '[X] a'), backendLine('WARN', '[X] b'), backendLine('INFO', '[X] ERROR: c')].join('\n'));
        assert.equal(cli(['--count-backend', backendPath]).stdout.trim(), 'Backend log lines during the run: 1 ERROR/FATAL, 1 WARN');
    });

    test('CLI: a valid summary without a log prints its failures', () => {
        const dir = mkdtempSync(join(tmpdir(), 'k6-annot-'));
        const summaryPath = join(dir, 's.json');
        writeFileSync(summaryPath, JSON.stringify({ failures: ['✗ checks: rate>0.99'] }));
        const r = cli(['flow', 'load', summaryPath, join(dir, 'none.log')]);
        assert.equal(r.stdout.trim(), '::error title=k6 flow (load) failed::✗ checks: rate>0.99');
    });
});
