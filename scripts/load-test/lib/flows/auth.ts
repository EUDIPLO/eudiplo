/**
 * OAuth2 client credentials token request, the baseline for the
 * authentication layer. Used by `api-auth` and by the token flow of `mixed`;
 * the other flows cache their operator token (see `adminToken` in helpers.ts).
 */

import http from 'k6/http';
import { check, group } from 'k6';
import { clientCredentialsBody } from '../helpers.ts';
import type { FlowContext } from './context.ts';

/** Request one token and check the response. Returns whether all checks passed. */
export function requestToken(ctx: FlowContext): boolean {
    let ok = false;
    group('client_credentials_flow', () => {
        const res = http.post(
            `${ctx.baseUrl}/api/oauth2/token`,
            clientCredentialsBody(ctx.clientId, ctx.clientSecret),
            {
                headers: { 'Content-Type': 'application/json' },
                tags: { stage: 'token' },
            },
        );

        ok = check(res, {
            'status is 201': (r) => r.status === 201,
            'access_token present': (r) => {
                try {
                    return !!r.json('access_token');
                } catch {
                    return false;
                }
            },
            'token_type is Bearer': (r) => {
                try {
                    return r.json('token_type') === 'Bearer';
                } catch {
                    return false;
                }
            },
        });
    });
    return ok;
}
