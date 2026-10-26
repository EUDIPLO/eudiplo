/**
 * Token Status List read path, relying-party side.
 *
 *   1. Discover the tenant's status lists   (GET /issuers/:tenant/status-management/status-list-aggregation)
 *   2. Download each list JWT               (GET <status list uri>)
 */

import http from 'k6/http';
import { check, fail, group } from 'k6';
import { assertStatus, envNumber } from '../helpers.ts';
import { type FlowContext, stage } from './context.ts';

/** URIs of the tenant's status lists, at most `MAX_LISTS` (default 5). */
export function fetchStatusListUris(ctx: FlowContext): string[] {
    const maxLists = envNumber('MAX_LISTS', 5);
    let uris: string[] = [];

    group('status_list_aggregation', () => {
        const res = http.get(
            `${ctx.baseUrl}/issuers/${ctx.tenantId}/status-management/status-list-aggregation`,
            { headers: { Accept: 'application/json' }, tags: stage(ctx, 'aggregation') },
        );
        assertStatus(res, 200, 'status list aggregation');

        // StatusListAggregationDto: { status_lists: string[] }. Anything else
        // is a broken response, not "no status lists yet".
        let lists: unknown;
        try {
            lists = (res.json() as Record<string, unknown>)?.status_lists;
        } catch {
            lists = undefined;
        }
        if (!Array.isArray(lists)) {
            fail(`status list aggregation: expected { status_lists: [...] }, got: ${res.body}`);
        }
        uris = (lists as string[]).slice(0, maxLists);
    });

    return uris;
}

/** Download every status list and check that it is a JWT. Returns the count fetched. */
export function fetchStatusLists(ctx: FlowContext, uris: string[]): number {
    let fetched = 0;
    group('fetch_status_lists', () => {
        for (const uri of uris) {
            const res = http.get(uri, {
                headers: { Accept: 'application/statuslist+jwt' },
                tags: stage(ctx, 'status_list'),
            });
            const ok = check(res, {
                'status list: status 200': (r) => r.status === 200,
                // Token Status List: the JWT form is served as application/statuslist+jwt.
                'status list: statuslist+jwt content-type': (r) =>
                    (r.headers['Content-Type'] || '').includes('application/statuslist+jwt'),
                'status list: non-empty body': (r) => !!r.body && (r.body as string).length > 0,
            });
            if (ok) fetched++;
        }
    });
    return fetched;
}
