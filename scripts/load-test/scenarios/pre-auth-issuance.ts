/**
 * pre-auth-issuance scenario — Full OID4VCI pre-authorized_code credential
 * issuance flow, plus the status-list write path.
 *
 * Each iteration runs the complete wallet-side issuance (see
 * lib/flows/issuance.ts) and, for a share of the issued credentials, the
 * operator-side revocation that rewrites and re-signs the status list.
 *
 * The operator token is obtained once in setup() and cached per VU; the
 * holder key pair is generated once and shared by all VUs.
 *
 * Environment variables:
 *   BASE_URL              - Backend base URL (default: http://localhost:3000)
 *   TENANT_ID             - Issuer tenant ID (default: demo)
 *   CLIENT_ID             - OAuth2 client ID (default: test-client)
 *   CLIENT_SECRET         - OAuth2 client secret (default: test-client-secret)
 *   CREDENTIAL_CONFIG_ID  - Credential configuration to issue (default: pid)
 *   REVOKE_RATIO          - Share of issued credentials to revoke, 0..1 (default: 0.1)
 *   SEED_SESSIONS         - Sessions created in setup before measuring (default: 0)
 *   THINK_TIME_MIN/MAX    - Seconds between operator and wallet steps
 *                           (default: 0 for once/smoke, 0–1 for spike, 1–5 otherwise)
 *   K6_PROFILE            - Load profile: once | smoke | load | stress | spike (default: smoke)
 *
 * Requirements:
 *   k6 >= 2.0.0   (global WebCrypto API)
 */

import { Counter, Trend } from 'k6/metrics';
import { scenarioOptions } from '../k6.config.ts';
import { adminToken, envNumber } from '../lib/helpers.ts';
import { flowContext, type WalletSetupData } from '../lib/flows/context.ts';
import { issueCredential, revokeCredential } from '../lib/flows/issuance.ts';
import { seedSessions } from '../lib/flows/seed.ts';
import { setupWallet } from '../lib/flows/setup.ts';

export { handleSummary } from '../lib/summary.ts';

const ctx = flowContext();
const REVOKE_RATIO = envNumber('REVOKE_RATIO', 0.1);

export const options = scenarioOptions({
    name: 'pre_auth_issuance',
    // Complete issuances per second under the `load` profile.
    baseRate: 10,
    pauses: 1,
    thresholds: {
        'http_req_duration{stage:offer}': ['p(95)<100'],
        'http_req_duration{stage:resolve_offer}': ['p(95)<50'],
        'http_req_duration{stage:token_exchange}': ['p(95)<50'],
        'http_req_duration{stage:nonce}': ['p(95)<50'],
        // Credential issuance signs the SD-JWT and allocates a status entry.
        'http_req_duration{stage:credential}': ['p(95)<250', 'p(99)<500'],
        // Revocation rewrites and re-signs the status list.
        'http_req_duration{stage:revoke}': ['p(95)<250'],
        issuance_success: ['count>0'],
    },
});

const issuanceSuccess = new Counter('issuance_success');
const issuanceDuration = new Trend('issuance_total_duration', true);
const revocations = new Counter('issuance_revocations');

export async function setup(): Promise<WalletSetupData> {
    const data = await setupWallet(ctx, 0);
    seedSessions(ctx, data.adminToken.token);
    return data;
}

export default async function (data: WalletSetupData): Promise<void> {
    const token = adminToken(ctx.baseUrl, ctx.clientId, ctx.clientSecret, data.adminToken);
    const start = Date.now();

    const issued = await issueCredential(ctx, token, data.holder);
    issuanceSuccess.add(1);
    issuanceDuration.add(Date.now() - start);

    if (REVOKE_RATIO > 0 && Math.random() < REVOKE_RATIO) {
        revokeCredential(ctx, token, issued.sessionId);
        revocations.add(1);
    }
}
