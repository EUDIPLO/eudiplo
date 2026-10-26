/**
 * status-list scenario — Token Status List read performance.
 *
 * Each iteration discovers the tenant's status lists through the aggregation
 * endpoint and downloads each list JWT (up to MAX_LISTS). setup() issues one
 * status-managed credential if the tenant has no status list yet, so the
 * scenario is self-contained.
 *
 * Status lists are cached, signed documents, so this measures the cache
 * path. The write path (revocation → re-signed list) is part of the
 * pre-auth-issuance scenario (REVOKE_RATIO) and of the mixed workload.
 *
 * Environment variables:
 *   BASE_URL    - Backend base URL (default: http://localhost:3000)
 *   TENANT_ID   - Issuer tenant ID (default: demo)
 *   MAX_LISTS   - Max status lists to fetch per iteration (default: 5)
 *   K6_PROFILE  - Load profile: once | smoke | load | stress | spike (default: smoke)
 */

import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { scenarioOptions } from '../k6.config.ts';
import { flowContext } from '../lib/flows/context.ts';
import { setupWallet } from '../lib/flows/setup.ts';
import { fetchStatusListUris, fetchStatusLists } from '../lib/flows/status-list.ts';

export { handleSummary } from '../lib/summary.ts';

const ctx = flowContext();

export const options = scenarioOptions({
    name: 'status_list',
    // Relying-party status checks per second under the `load` profile.
    baseRate: 200,
    requestSeconds: 0.05,
    thresholds: {
        // Status lists are cached JWT documents — should be very fast.
        'http_req_duration{stage:aggregation}': ['p(95)<50'],
        'http_req_duration{stage:status_list}': ['p(95)<50', 'p(99)<150'],
        status_list_fetched: ['count>0'],
    },
});

const aggregationFetched = new Counter('status_list_aggregation_fetched');
const statusListFetched = new Counter('status_list_fetched');
const statusListDuration = new Trend('status_list_fetch_duration', true);

export async function setup(): Promise<void> {
    const setupCtx = { ...ctx, inSetup: true };
    if (fetchStatusListUris(setupCtx).length === 0) {
        // No status list yet: issue one status-managed credential. This
        // scenario does not seed sessions (SEED_SESSIONS is ignored).
        await setupWallet(setupCtx, 1);
    }
}

export default function (): void {
    const uris = fetchStatusListUris(ctx);
    aggregationFetched.add(1);

    if (uris.length === 0) {
        check(null, {
            'WARN: no status lists found (issue a credential first)': () => false,
        });
        return;
    }

    const start = Date.now();
    statusListFetched.add(fetchStatusLists(ctx, uris));
    statusListDuration.add((Date.now() - start) / uris.length);
}
