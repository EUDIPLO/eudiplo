import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import http from 'k6/http';
import { topErrors } from '../lib/failure-annotation.mjs';
import { checkSessionResult, sessionFailure, submitAuthorizationResponse } from '../lib/flows/presentation.ts';

const original = { get: http.get, post: http.post };
afterEach(() => {
    http.get = original.get;
    http.post = original.post;
});

const ctx = { baseUrl: 'http://backend', inSetup: false };
const requestObject = { response_uri: 'http://backend/presentations/n/oid4vp' };
const diagnose = () => sessionFailure(ctx, 't', 's-1');

function response(status, body) {
    return {
        status,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        json(path) {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            return path ? parsed[path] : parsed;
        },
    };
}

describe('submitAuthorizationResponse', () => {
    test('an accepted response does not read the session', () => {
        http.post = () => response(200, {});
        http.get = () => assert.fail('no session lookup expected');
        submitAuthorizationResponse(ctx, requestObject, 'jwe', diagnose);
    });

    test("a rejection carries the verifier's failure code and reason before the body", () => {
        http.post = () => response(400, { statusCode: 400 });
        const requested = [];
        http.get = (url, params) => {
            requested.push({ url, auth: params.headers.Authorization, stage: params.tags.stage });
            return response(200, { status: 'failed', failureCode: 'invalid_presentation', errorReason: 'Issuer not trusted' });
        };
        assert.throws(
            () => submitAuthorizationResponse(ctx, requestObject, 'jwe', diagnose),
            /unexpected status 400; verifier: invalid_presentation: Issuer not trusted\. Body: /,
        );
        assert.deepEqual(requested, [{ url: 'http://backend/api/session/s-1', auth: 'Bearer t', stage: 'vp_diagnose' }]);
    });

    test('the same reason with different bodies is one annotation group', () => {
        http.get = () => response(200, { status: 'failed', failureCode: 'x', errorReason: 'y' });
        const messages = ['a', 'b'].map((id) => {
            http.post = () => response(400, { path: id });
            try {
                submitAuthorizationResponse(ctx, requestObject, 'jwe', diagnose);
            } catch (e) {
                return `level=error msg="${e.message.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
            }
            return assert.fail('expected a failure');
        });
        assert.equal(topErrors(messages.join('\n')).length, 1);
        assert.match(topErrors(messages.join('\n'))[0], /^2× /);
    });
});

describe('sessionFailure', () => {
    test('a session that did not fail is not reported as a verifier failure', () => {
        http.get = () => response(200, { status: 'completed' });
        assert.equal(sessionFailure(ctx, 't', 's'), '; session: completed');
    });

    test('a failed session without a reason reports its code', () => {
        http.get = () => response(200, { status: 'failed', failureCode: 'expired' });
        assert.equal(sessionFailure(ctx, 't', 's'), '; verifier: expired');
    });

    test('fallbacks for a missing code or status', () => {
        http.get = () => response(200, { status: 'failed', errorReason: 'r' });
        assert.equal(sessionFailure(ctx, 't', 's'), '; verifier: failed: r');
        http.get = () => response(200, {});
        assert.equal(sessionFailure(ctx, 't', 's'), '; session: unknown');
    });

    test('an unreadable session adds nothing', () => {
        http.get = () => response(403, { error: 'forbidden' });
        assert.equal(sessionFailure(ctx, 't', 's'), '');
        http.get = () => response(200, 'not json');
        assert.equal(sessionFailure(ctx, 't', 's'), '');
    });
});

describe('checkSessionResult', () => {
    test('passes for a completed session and throws on a non-200', () => {
        http.get = () => response(200, { status: 'completed' });
        checkSessionResult(ctx, 't', 's');
        http.get = () => response(404, { error: 'not found' });
        assert.throws(() => checkSessionResult(ctx, 't', 's'), /session result: unexpected status 404/);
    });
});
