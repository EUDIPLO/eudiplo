/**
 * oid4vp-presentation scenario — complete OID4VP presentation including the
 * wallet's response.
 *
 * setup() issues CREDENTIAL_POOL_SIZE credentials to a generated holder key.
 * Each iteration then runs the verifier and wallet side of one presentation
 * (see lib/flows/presentation.ts): create the request, fetch the request
 * object, build an SD-JWT presentation with key binding for the claims the
 * DCQL query asks for, encrypt it for the verifier and submit it. The
 * verifier's signature, trust-list, status-list and DCQL checks therefore
 * run under load.
 *
 * Environment variables:
 *   BASE_URL              - Backend base URL (default: http://localhost:3000)
 *   TENANT_ID             - Tenant that issues the test credential (default: demo)
 *   CLIENT_ID             - OAuth2 client ID (default: test-client; needs
 *                           issuance:offer for setup and presentation:request)
 *   CLIENT_SECRET         - OAuth2 client secret (default: test-client-secret)
 *   REQUEST_ID            - Verifier request config ID (default: age-over-18)
 *   CREDENTIAL_CONFIG_ID  - Credential configuration issued in setup (default: pid)
 *   CREDENTIAL_POOL_SIZE  - Credentials issued in setup (default: 5)
 *   CREDENTIAL_JWT        - Present this SD-JWT VC instead of issuing one;
 *                           needs HOLDER_PRIVATE_JWK (the key in its cnf claim)
 *   DCQL_CREDENTIAL_ID    - DCQL credential query to answer (default: the
 *                           first dc+sd-jwt query)
 *   CHECK_SESSION_RESULT  - Also read /api/session/:id and expect "completed"
 *                           (default: false)
 *   SEED_SESSIONS         - Sessions created in setup before measuring (default: 0)
 *   THINK_TIME_MIN/MAX    - Seconds between operator and wallet steps
 *                           (default: 0 for once/smoke, 0–1 for spike, 1–5 otherwise)
 *   K6_PROFILE            - Load profile: once | smoke | load | stress | spike (default: smoke)
 */

import { Counter, Trend } from 'k6/metrics';
import { scenarioOptions } from '../k6.config.ts';
import { adminToken, envNumber, pickRandom } from '../lib/helpers.ts';
import { flowContext, type WalletSetupData } from '../lib/flows/context.ts';
import { presentCredential } from '../lib/flows/presentation.ts';
import { seedSessions } from '../lib/flows/seed.ts';
import { setupWallet } from '../lib/flows/setup.ts';

export { handleSummary } from '../lib/summary.ts';

const ctx = flowContext();

export const options = scenarioOptions({
    name: 'oid4vp_presentation',
    // Complete presentations per second under the `load` profile.
    baseRate: 10,
    pauses: 2,
    thresholds: {
        'http_req_duration{stage:vp_offer}': ['p(95)<100'],
        'http_req_duration{stage:vp_request_object}': ['p(95)<50'],
        // Verification: KB-JWT and issuer signature, trust list, status list, DCQL.
        'http_req_duration{stage:vp_response}': ['p(95)<500', 'p(99)<1000'],
        presentation_success: ['count>0'],
    },
});

const presentationSuccess = new Counter('presentation_success');
const presentationDuration = new Trend('presentation_total_duration', true);

export async function setup(): Promise<WalletSetupData> {
    const data = await setupWallet(ctx, Math.max(1, envNumber('CREDENTIAL_POOL_SIZE', 5)));
    seedSessions(ctx, data.adminToken.token);
    return data;
}

export default async function (data: WalletSetupData): Promise<void> {
    const token = adminToken(ctx.baseUrl, ctx.clientId, ctx.clientSecret, data.adminToken);
    const start = Date.now();

    await presentCredential(ctx, token, pickRandom(data.credentials), data.holder);

    presentationSuccess.add(1);
    presentationDuration.add(Date.now() - start);
}
