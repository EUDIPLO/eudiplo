/**
 * api-auth scenario — OAuth2 client credentials token endpoint baseline.
 *
 * Exercises: POST /api/oauth2/token
 *
 * This is the simplest scenario and establishes a latency / throughput
 * baseline for the authentication layer. Like the token flow of `mixed`, it
 * requests a token on every iteration; the other flows cache the operator
 * token.
 *
 * Environment variables:
 *   BASE_URL      - Backend base URL (default: http://localhost:3000)
 *   CLIENT_ID     - OAuth2 client ID (default: test-client)
 *   CLIENT_SECRET - OAuth2 client secret (default: test-client-secret)
 *   K6_PROFILE    - Load profile: once | smoke | load | stress | spike (default: smoke)
 */

import { Counter, Trend } from 'k6/metrics';
import { scenarioOptions } from '../k6.config.ts';
import { requestToken } from '../lib/flows/auth.ts';
import { flowContext } from '../lib/flows/context.ts';

export { handleSummary } from '../lib/summary.ts';

const ctx = flowContext();

export const options = scenarioOptions({
    name: 'api_auth',
    // Token requests per second under the `load` profile.
    baseRate: 30,
    requestSeconds: 0.1,
    thresholds: {
        'http_req_duration{stage:token}': ['p(95)<200', 'p(99)<400'],
    },
});

const tokenSuccess = new Counter('auth_token_success');
const tokenDuration = new Trend('auth_token_duration', true);

export default function (): void {
    const start = Date.now();
    const ok = requestToken(ctx);
    tokenDuration.add(Date.now() - start);
    if (ok) {
        tokenSuccess.add(1);
    }
}
