/**
 * OID4VP presentation flow, verifier and wallet side.
 *
 *   1. Operator creates a presentation request     (POST /api/verifier/offer)
 *   2. Wallet fetches the request object            (GET  /presentations/:nonce/oid4vp/request)
 *   3. Wallet builds an SD-JWT presentation with the claims the DCQL query
 *      asks for, adds a Key Binding JWT, encrypts the response for the
 *      verifier (ECDH-ES, direct_post.jwt) and posts it
 *                                                   (POST /presentations/:nonce/oid4vp)
 *   4. Optionally the operator reads the session result (GET /session/:id)
 *
 * Step 3 is where the verifier does its work: signature and key-binding
 * verification, trust-list and status-list checks, DCQL evaluation.
 */

import http from 'k6/http';
import { check, fail, group } from 'k6';
import { assertStatus, authParams, envBool, parseQueryString, thinkTime } from '../helpers.ts';
import {
    addKeyBinding,
    decodeJwtPayload,
    encryptJwe,
    holderPrivateKey,
    type JweEnc,
    selectDisclosures,
} from '../crypto.ts';
import { type FlowContext, type HolderKeys, stage } from './context.ts';

interface PresentationOffer {
    session: string;
    uri: string;
}

interface DcqlClaimQuery {
    id?: string;
    path: Array<string | number | null>;
}

export interface DcqlCredentialQuery {
    id: string;
    format: string;
    claims?: DcqlClaimQuery[];
    claim_sets?: string[][];
}

export interface RequestObject {
    client_id: string;
    nonce: string;
    state?: string;
    response_uri: string;
    response_mode?: string;
    dcql_query?: { credentials: DcqlCredentialQuery[] };
    client_metadata?: {
        jwks?: { keys: JsonWebKey[] };
        encrypted_response_enc_values_supported?: string[];
    };
}

export interface PresentationResult {
    sessionId: string;
}

/** Request body of the operator's presentation request. */
export function presentationOfferBody(ctx: FlowContext): Record<string, unknown> {
    return { response_type: 'uri', requestId: ctx.requestId };
}

/** Create the presentation request and return its session and offer URI. */
export function createPresentationRequest(ctx: FlowContext, adminToken: string): PresentationOffer {
    let offer!: PresentationOffer;
    group('create_presentation_offer', () => {
        const res = http.post(
            `${ctx.baseUrl}/api/verifier/offer`,
            JSON.stringify(presentationOfferBody(ctx)),
            authParams(adminToken, stage(ctx, 'vp_offer')),
        );
        assertStatus(res, 201, 'create presentation offer');
        offer = res.json() as PresentationOffer;
        check(offer, {
            'session ID present': (o) => typeof o.session === 'string' && o.session.length > 0,
            'offer URI present': (o) => typeof o.uri === 'string' && o.uri.startsWith('openid4vp://'),
        });
    });
    return offer;
}

/** Fetch the signed request object the offer URI points to. */
export function fetchRequestObject(ctx: FlowContext, offer: PresentationOffer): RequestObject {
    let requestObject!: RequestObject;
    group('fetch_request_object', () => {
        // The wallet-facing URL carries the wallet nonce, not the session ID
        // (OID4VP §13.3), so there is no URL to build from the session.
        const requestUrl = parseQueryString(offer.uri).request_uri;
        if (!requestUrl) {
            fail(`offer URI without request_uri: ${offer.uri}`);
        }

        const res = http.get(requestUrl, {
            headers: { Accept: 'application/oauth-authz-req+jwt, application/json' },
            tags: stage(ctx, 'vp_request_object'),
        });
        const ok = check(res, {
            'request object: status 200': (r) => r.status === 200,
            'request object: non-empty body': (r) => !!r.body && (r.body as string).length > 0,
        });
        if (!ok) {
            fail(`request object: ${res.status} ${res.body}`);
        }
        requestObject = decodeJwtPayload<RequestObject>((res.body as string).trim());
        check(requestObject, {
            'request object: nonce and response_uri present': (r) =>
                typeof r.nonce === 'string' && typeof r.response_uri === 'string',
            'request object: response encryption key present': (r) =>
                Array.isArray(r.client_metadata?.jwks?.keys) && r.client_metadata!.jwks!.keys.length > 0,
        });
    });
    return requestObject;
}

/**
 * Build the wallet's encrypted authorization response for `requestObject`
 * from an issued SD-JWT VC.
 */
export async function buildAuthorizationResponse(
    requestObject: RequestObject,
    credential: string,
    holder: HolderKeys,
): Promise<string> {
    const query = selectCredentialQuery(requestObject);

    // Selective disclosure: only the claims the verifier asks for. Without a
    // `claims` list the verifier asks for the whole credential.
    const paths = requestedClaimPaths(query);
    const presentation = paths.length
        ? await selectDisclosures(credential, paths)
        : stripKeyBinding(credential);

    const holderKey = await holderPrivateKey(holder.privateJwk);
    const vpToken = await addKeyBinding(
        presentation,
        holderKey,
        requestObject.client_id,
        requestObject.nonce,
    );

    const payload: Record<string, unknown> = {
        vp_token: { [query.id]: [vpToken] },
    };
    if (requestObject.state) {
        payload.state = requestObject.state;
    }

    const encryptionKey = requestObject.client_metadata!.jwks!.keys[0];
    return encryptJwe(payload, encryptionKey, chooseEnc(requestObject));
}

/**
 * Post the encrypted response to the verifier. `detail` explains a rejection
 * in the failure message; the wallet-facing error body carries no reason.
 */
export function submitAuthorizationResponse(
    ctx: FlowContext,
    requestObject: RequestObject,
    response: string,
    detail?: () => string,
): void {
    group('submit_response', () => {
        const res = http.post(
            requestObject.response_uri,
            { response },
            { tags: stage(ctx, 'vp_response') },
        );
        assertStatus(res, 200, 'authorization response', detail);
    });
}

interface SessionView {
    status?: string;
    failureCode?: string;
    errorReason?: string;
}

/** The operator's view of a session, or undefined when it cannot be read. */
function getSession(
    ctx: FlowContext,
    adminToken: string,
    sessionId: string,
    stageName: string,
): { res: ReturnType<typeof http.get>; session?: SessionView } {
    const res = http.get(
        `${ctx.baseUrl}/api/session/${sessionId}`,
        authParams(adminToken, stage(ctx, stageName)),
    );
    if (res.status !== 200) return { res };
    try {
        return { res, session: res.json() as SessionView };
    } catch {
        return { res };
    }
}

/**
 * Why a rejected response failed, as `"; verifier: <failureCode>: <errorReason>"`
 * when the verifier marked the session failed, `"; session: <status>"` when it
 * did not (for example a response for an already used session), or `""` when
 * the session cannot be read.
 */
export function sessionFailure(ctx: FlowContext, adminToken: string, sessionId: string): string {
    const { session } = getSession(ctx, adminToken, sessionId, 'vp_diagnose');
    if (!session) return '';
    if (session.status !== 'failed') return `; session: ${session.status ?? 'unknown'}`;
    const code = session.failureCode ?? 'failed';
    return session.errorReason ? `; verifier: ${code}: ${session.errorReason}` : `; verifier: ${code}`;
}

/** Read the session the operator sees and check that verification succeeded. */
export function checkSessionResult(ctx: FlowContext, adminToken: string, sessionId: string): void {
    group('session_result', () => {
        const { res, session } = getSession(ctx, adminToken, sessionId, 'vp_session');
        assertStatus(res, 200, 'session result');
        check(session, {
            'session result: status completed': (sv) => sv?.status === 'completed',
        });
    });
}

/**
 * Run one complete presentation of `credential`. `think` pauses are taken
 * where the user scans the QR code and where they confirm the disclosure.
 */
export async function presentCredential(
    ctx: FlowContext,
    adminToken: string,
    credential: string,
    holder: HolderKeys,
): Promise<PresentationResult> {
    const offer = createPresentationRequest(ctx, adminToken);

    // The user scans the QR code.
    thinkTime(ctx.think);

    const requestObject = fetchRequestObject(ctx, offer);

    // The wallet shows the request, the user consents.
    thinkTime(ctx.think);

    const response = await buildAuthorizationResponse(requestObject, credential, holder);
    // On a rejection, take the reason from the operator's view of the session.
    submitAuthorizationResponse(ctx, requestObject, response, () =>
        sessionFailure(ctx, adminToken, offer.session),
    );

    if (envBool('CHECK_SESSION_RESULT', false)) {
        checkSessionResult(ctx, adminToken, offer.session);
    }

    return { sessionId: offer.session };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function selectCredentialQuery(requestObject: RequestObject): DcqlCredentialQuery {
    const credentials = requestObject.dcql_query?.credentials ?? [];
    const wanted = __ENV.DCQL_CREDENTIAL_ID;
    const query = wanted
        ? credentials.find((c) => c.id === wanted)
        : credentials.find((c) => c.format === 'dc+sd-jwt');
    if (!query) {
        fail(
            `No dc+sd-jwt credential query in the request object (DCQL_CREDENTIAL_ID=${wanted ?? '-'}); ` +
                `available: ${credentials.map((c) => `${c.id} (${c.format})`).join(', ')}`,
        );
    }
    return query!;
}

/**
 * Claim paths the wallet discloses for a credential query. With `claim_sets`
 * the verifier asks for one combination and the wallet returns the first one
 * it can satisfy (OID4VP 1.0 §6.4.1); the test credential is generated from
 * the issuer's configuration, so the first set whose claim ids all exist is
 * used. Without `claim_sets`, every entry of `claims` is requested.
 */
export function requestedClaimPaths(query: DcqlCredentialQuery): Array<Array<string | number | null>> {
    const claims = query.claims ?? [];
    if (!query.claim_sets?.length) {
        return claims.map((c) => c.path);
    }
    const byId = new Map(claims.filter((c) => c.id).map((c) => [c.id as string, c.path]));
    const set = query.claim_sets.find((ids) => ids.every((id) => byId.has(id)));
    if (!set) {
        fail(`No claim set of credential query "${query.id}" references only defined claim ids`);
    }
    return set!.map((id) => byId.get(id)!);
}

/**
 * An SD-JWT presentation without key binding, `<jwt>~<disclosures>~`: drops a
 * trailing KB-JWT (the last `~`-separated segment, when it is a JWT).
 */
export function stripKeyBinding(credential: string): string {
    const parts = credential.split('~');
    if (parts.length > 1 && parts[parts.length - 1].includes('.')) {
        parts[parts.length - 1] = '';
    }
    const joined = parts.join('~');
    return joined.endsWith('~') ? joined : `${joined}~`;
}

export function chooseEnc(requestObject: RequestObject): JweEnc {
    const supported = requestObject.client_metadata?.encrypted_response_enc_values_supported;
    if (!supported || supported.includes('A128GCM')) return 'A128GCM';
    if (supported.includes('A256GCM')) return 'A256GCM';
    fail(`Verifier supports none of A128GCM/A256GCM: ${supported.join(', ')}`);
    return 'A128GCM';
}
