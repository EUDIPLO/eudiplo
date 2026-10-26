/**
 * Shared HTTP helper utilities for EUDIPLO k6 load tests.
 */

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import type { Params, RefinedResponse, ResponseType } from 'k6/http';

/** Credential offer shape returned by the resolve step. */
export interface CredentialOffer {
    credential_issuer?: string;
    credential_configuration_ids?: string[];
    grants?: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: {
            'pre-authorized_code'?: string;
        };
    };
}

/** An OAuth2 access token with its absolute expiry. */
export interface AccessToken {
    token: string;
    /** Epoch milliseconds. */
    expiresAt: number;
}

/** JSON body of the OAuth2 client credentials token request. */
export function clientCredentialsBody(clientId: string, clientSecret: string): string {
    return JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });
}

/**
 * Obtain an OAuth2 Bearer token using the client credentials flow.
 */
export function requestAdminToken(
    baseUrl: string,
    clientId: string,
    clientSecret: string,
    tags: Record<string, string> = { stage: 'token' },
): AccessToken {
    const res = http.post(
        `${baseUrl}/api/oauth2/token`,
        clientCredentialsBody(clientId, clientSecret),
        { headers: { 'Content-Type': 'application/json' }, tags },
    );

    const ok = check(res, { 'admin token: status 201': (r) => r.status === 201 });
    if (!ok) {
        fail(`Failed to obtain admin token: ${res.status} ${res.body}`);
    }

    const expiresIn = Number(res.json('expires_in') ?? 300);
    return {
        token: res.json('access_token') as string,
        expiresAt: Date.now() + expiresIn * 1000,
    };
}

/**
 * Per-VU token cache. The operator token is obtained once in `setup()` and
 * handed to every VU; a VU refreshes it only when it is about to expire.
 * Fetching a token on every iteration would make the client-credentials
 * endpoint (secret verification is deliberately slow) the bottleneck of
 * flows that are supposed to measure issuance or presentation.
 */
let cachedToken: AccessToken | undefined;

export function adminToken(
    baseUrl: string,
    clientId: string,
    clientSecret: string,
    initial?: AccessToken,
): string {
    if (!cachedToken && initial) {
        cachedToken = initial;
    }
    const refreshBefore = 60_000;
    if (!cachedToken || Date.now() > cachedToken.expiresAt - refreshBefore) {
        cachedToken = requestAdminToken(baseUrl, clientId, clientSecret, {
            stage: 'token_refresh',
        });
    }
    return cachedToken.token;
}

/**
 * Build a URL-encoded form body string from a plain object.
 */
export function formEncode(params: Record<string, string>): string {
    return Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

/**
 * Parse the query string portion of a URL into a plain object.
 * Works with any scheme (including openid-credential-offer://).
 */
export function parseQueryString(uri: string): Record<string, string> {
    const qsStart = uri.indexOf('?');
    if (qsStart < 0) return {};
    const qs = uri.slice(qsStart + 1);
    const result: Record<string, string> = {};
    for (const pair of qs.split('&')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 0) continue;
        const key = decodeURIComponent(pair.slice(0, eqIdx));
        const val = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, ' '));
        result[key] = val;
    }
    return result;
}

/**
 * Resolve a credential offer URI into the parsed credential offer object.
 * Handles both inline (?credential_offer=) and by-reference (?credential_offer_uri=) forms.
 */
export function resolveCredentialOffer(
    offerUri: string,
    tags: Record<string, string> = { stage: 'resolve_offer' },
): CredentialOffer {
    const params = parseQueryString(offerUri);

    if (params.credential_offer) {
        return JSON.parse(params.credential_offer) as CredentialOffer;
    }

    if (params.credential_offer_uri) {
        const res = http.get(params.credential_offer_uri, {
            headers: { Accept: 'application/json' },
            tags,
        });
        const ok = check(res, {
            'credential offer fetch: status 200': (r) => r.status === 200,
        });
        if (!ok) {
            fail(`Failed to fetch credential offer: ${res.status} ${res.body}`);
        }
        return res.json() as CredentialOffer;
    }

    fail(`Unrecognised credential offer URI format: ${offerUri}`);
    // fail() throws, but TypeScript doesn't know that
    return {} as CredentialOffer;
}

/**
 * Extract the pre-authorized_code from a resolved credential offer.
 */
export function extractPreAuthCode(credentialOffer: CredentialOffer): string {
    const grants = credentialOffer.grants ?? {};
    const preAuthGrant =
        grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
    if (!preAuthGrant || !preAuthGrant['pre-authorized_code']) {
        fail('Credential offer does not contain a pre-authorized_code grant');
    }
    return preAuthGrant!['pre-authorized_code'] as string;
}

/**
 * Assert that an HTTP response has the expected status code and fail the iteration
 * with a helpful message if not. `detail` adds context to the message (it is
 * only evaluated on failure); it goes before ". Body:", so failures with the
 * same detail are grouped in the CI annotation.
 */
export function assertStatus(
    res: RefinedResponse<ResponseType | undefined>,
    expectedStatus: number,
    label: string,
    detail?: () => string,
): void {
    const ok = check(res, {
        [`${label}: status ${expectedStatus}`]: (r) => r.status === expectedStatus,
    });
    if (!ok) {
        fail(`${label}: unexpected status ${res.status}${detail ? detail() : ''}. Body: ${res.body}`);
    }
}

/**
 * Build the set of standard request params for the EUDIPLO backend.
 */
export function authParams(token: string, tags?: Record<string, string>): Params {
    return {
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        tags,
    };
}

/**
 * Pause for a random duration in `[min, max]` seconds, simulating the time a
 * user needs between two steps (scanning a QR code, confirming consent). A
 * zero range is a no-op, so `once` and `smoke` runs stay fast.
 */
export function thinkTime(range: { min: number; max: number }): void {
    if (range.max <= 0) return;
    sleep(range.min + Math.random() * (range.max - range.min));
}

/** Pick a random element. */
export function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

/** Read a numeric environment variable with a default. */
export function envNumber(name: string, fallback: number): number {
    const raw = __ENV[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (Number.isNaN(n)) {
        throw new Error(`${name} must be a number, got "${raw}"`);
    }
    return n;
}

/** Read a boolean environment variable (`true`/`false`, default given). */
export function envBool(name: string, fallback: boolean): boolean {
    const raw = __ENV[name];
    if (raw === undefined || raw === '') return fallback;
    return raw.toLowerCase() === 'true';
}
