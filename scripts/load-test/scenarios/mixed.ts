/**
 * mixed scenario — production-like concurrent workload.
 *
 * Runs the flows of the other scenarios at the same time, each at its own
 * rate: issuance (with revocations), presentation, status-list reads and
 * token requests. This is what the backend sees in production, and it is
 * the scenario to run with the `load` profile for a capacity figure that
 * accounts for the flows competing for the same database and signing keys.
 *
 * Rates are per second under the `load` profile and can be overridden:
 *   MIXED_ISSUANCE_RATE      (default: 10)
 *   MIXED_PRESENTATION_RATE  (default: 10)
 *   MIXED_STATUS_LIST_RATE   (default: 100)
 *   MIXED_AUTH_RATE          (default: 5)
 *
 * The scenario-specific variables of the single flows apply as well
 * (REVOKE_RATIO, CREDENTIAL_POOL_SIZE, THINK_TIME_MIN/MAX, ...).
 */

import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { multiScenarioOptions } from '../k6.config.ts';
import { adminToken, envNumber, pickRandom } from '../lib/helpers.ts';
import { requestToken } from '../lib/flows/auth.ts';
import { flowContext, type WalletSetupData } from '../lib/flows/context.ts';
import { issueCredential, revokeCredential } from '../lib/flows/issuance.ts';
import { presentCredential } from '../lib/flows/presentation.ts';
import { seedSessions } from '../lib/flows/seed.ts';
import { setupWallet } from '../lib/flows/setup.ts';
import { fetchStatusListUris, fetchStatusLists } from '../lib/flows/status-list.ts';

export { handleSummary } from '../lib/summary.ts';

const ctx = flowContext();
const REVOKE_RATIO = envNumber('REVOKE_RATIO', 0.1);

export const options = multiScenarioOptions([
    {
        name: 'issuance',
        exec: 'issuance',
        baseRate: envNumber('MIXED_ISSUANCE_RATE', 10),
        pauses: 1,
        thresholds: {
            'http_req_duration{stage:offer}': ['p(95)<100'],
            // Twice the single-flow limit: here the token exchange shares the
            // database with concurrent issuance, revocation and status-list
            // writes on the same CPU-limited backend.
            'http_req_duration{stage:token_exchange}': ['p(95)<100'],
            'http_req_duration{stage:credential}': ['p(95)<250', 'p(99)<500'],
            'http_req_duration{stage:revoke}': ['p(95)<250'],
            issuance_success: ['count>0'],
        },
    },
    {
        name: 'presentation',
        exec: 'presentation',
        baseRate: envNumber('MIXED_PRESENTATION_RATE', 10),
        pauses: 2,
        thresholds: {
            'http_req_duration{stage:vp_offer}': ['p(95)<100'],
            'http_req_duration{stage:vp_request_object}': ['p(95)<50'],
            'http_req_duration{stage:vp_response}': ['p(95)<500', 'p(99)<1000'],
            presentation_success: ['count>0'],
        },
    },
    {
        name: 'status_list',
        exec: 'statusList',
        baseRate: envNumber('MIXED_STATUS_LIST_RATE', 100),
        requestSeconds: 0.05,
        thresholds: {
            'http_req_duration{stage:aggregation}': ['p(95)<50'],
            'http_req_duration{stage:status_list}': ['p(95)<50', 'p(99)<150'],
        },
    },
    {
        name: 'auth',
        exec: 'auth',
        baseRate: envNumber('MIXED_AUTH_RATE', 5),
        requestSeconds: 0.1,
        thresholds: {
            'http_req_duration{stage:token}': ['p(95)<200'],
        },
    },
]);

const issuanceSuccess = new Counter('issuance_success');
const presentationSuccess = new Counter('presentation_success');
const statusListFetched = new Counter('status_list_fetched');

export async function setup(): Promise<WalletSetupData> {
    const data = await setupWallet(ctx, Math.max(1, envNumber('CREDENTIAL_POOL_SIZE', 5)));
    seedSessions(ctx, data.adminToken.token);
    return data;
}

export async function issuance(data: WalletSetupData): Promise<void> {
    const token = adminToken(ctx.baseUrl, ctx.clientId, ctx.clientSecret, data.adminToken);
    const issued = await issueCredential(ctx, token, data.holder);
    issuanceSuccess.add(1);
    if (REVOKE_RATIO > 0 && Math.random() < REVOKE_RATIO) {
        revokeCredential(ctx, token, issued.sessionId);
    }
}

export async function presentation(data: WalletSetupData): Promise<void> {
    const token = adminToken(ctx.baseUrl, ctx.clientId, ctx.clientSecret, data.adminToken);
    await presentCredential(ctx, token, pickRandom(data.credentials), data.holder);
    presentationSuccess.add(1);
}

export function statusList(): void {
    const uris = fetchStatusListUris(ctx);
    if (uris.length === 0) {
        check(null, { 'WARN: no status lists found': () => false });
        return;
    }
    statusListFetched.add(fetchStatusLists(ctx, uris));
}

export function auth(): void {
    requestToken(ctx);
}
