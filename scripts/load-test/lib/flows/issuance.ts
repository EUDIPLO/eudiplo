/**
 * OID4VCI pre-authorized_code issuance flow, wallet side.
 *
 *   1. Operator creates a credential offer        (POST /api/issuer/offer)
 *   2. Wallet resolves the offer URI              → pre-authorized_code
 *   3. Wallet exchanges the code for a token      (POST /issuers/:tenant/authorize/token)
 *   4. Wallet fetches a c_nonce                   (POST /issuers/:tenant/vci/nonce)
 *   5. Wallet signs a key-binding proof JWT and requests the credential
 *                                                 (POST /issuers/:tenant/vci/credential)
 *   6. Optionally the operator revokes the credential (POST /api/session/revoke),
 *      which rewrites and re-signs the status list.
 */

import http from 'k6/http';
import { check, fail, group } from 'k6';
import {
    assertStatus,
    authParams,
    extractPreAuthCode,
    formEncode,
    resolveCredentialOffer,
    thinkTime,
} from '../helpers.ts';
import { holderPrivateKey, signProofJwt } from '../crypto.ts';
import { type FlowContext, type HolderKeys, stage } from './context.ts';

export interface IssuedCredential {
    sessionId: string;
    /** The SD-JWT VC including its disclosures (`<jwt>~<d1>~...~`). */
    credential: string;
}

interface OfferResponse {
    uri: string;
    session: string;
}

/** Request body of the operator's credential offer. */
export function issuanceOfferBody(ctx: FlowContext): Record<string, unknown> {
    return {
        response_type: 'uri',
        credentialConfigurationIds: [ctx.credentialConfigId],
        flow: 'pre_authorized_code',
    };
}

/**
 * Run one complete issuance and return the credential. A think-time pause is
 * taken between the operator creating the offer and the wallet redeeming it,
 * except in setup.
 */
export async function issueCredential(
    ctx: FlowContext,
    adminToken: string,
    holder: HolderKeys,
): Promise<IssuedCredential> {
    const issuerBase = `${ctx.baseUrl}/issuers/${ctx.tenantId}`;

    // Step 1: operator creates the offer
    let offer!: OfferResponse;
    group('create_offer', () => {
        const res = http.post(
            `${ctx.baseUrl}/api/issuer/offer`,
            JSON.stringify(issuanceOfferBody(ctx)),
            authParams(adminToken, stage(ctx, 'offer')),
        );
        assertStatus(res, 201, 'create offer');
        offer = res.json() as OfferResponse;
        check(offer, {
            'create offer: session present': (o) => typeof o.session === 'string' && o.session.length > 0,
        });
    });

    // The user scans the QR code / opens the link.
    if (!ctx.inSetup) {
        thinkTime(ctx.think);
    }

    // Step 2: wallet resolves the offer
    let preAuthCode!: string;
    // The proof's `aud` is the Credential Issuer Identifier from the offer,
    // which is derived from PUBLIC_URL and need not equal BASE_URL.
    let credentialIssuer = issuerBase;
    group('resolve_offer', () => {
        const resolved = resolveCredentialOffer(offer.uri, stage(ctx, 'resolve_offer'));
        preAuthCode = extractPreAuthCode(resolved);
        credentialIssuer = resolved.credential_issuer ?? issuerBase;
    });

    // Step 3: token exchange
    let walletAccessToken!: string;
    // OID4VCI 1.0 §8.2: with `authorization_details` in the token response
    // the request names one of its `credential_identifiers`; without, it
    // names the `credential_configuration_id`.
    let credentialSelector: Record<string, string> = {
        credential_configuration_id: ctx.credentialConfigId,
    };
    group('token_exchange', () => {
        const res = http.post(
            `${issuerBase}/authorize/token`,
            formEncode({
                grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
                'pre-authorized_code': preAuthCode,
            }),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                tags: stage(ctx, 'token_exchange'),
            },
        );
        assertStatus(res, 200, 'token exchange');
        walletAccessToken = res.json('access_token') as string;
        const details = res.json('authorization_details') as
            | Array<{ type?: string; credential_configuration_id?: string; credential_identifiers?: string[] }>
            | undefined;
        const entry = details?.find(
            (d) =>
                d.type === 'openid_credential' &&
                (d.credential_configuration_id === undefined ||
                    d.credential_configuration_id === ctx.credentialConfigId),
        );
        const identifier = entry?.credential_identifiers?.[0];
        if (identifier) {
            credentialSelector = { credential_identifier: identifier };
        }
    });

    // Step 4: c_nonce
    let cNonce!: string;
    group('nonce', () => {
        const res = http.post(`${issuerBase}/vci/nonce`, null, {
            headers: { 'Content-Type': 'application/json' },
            tags: stage(ctx, 'nonce'),
        });
        assertStatus(res, 200, 'nonce endpoint');
        cNonce = res.json('c_nonce') as string;
        check(cNonce, {
            'c_nonce is non-empty string': (v) => typeof v === 'string' && v.length > 0,
        });
    });

    // Step 5: proof + credential request. k6 group callbacks are synchronous,
    // so the WebCrypto work happens before entering the group.
    const holderKey = await holderPrivateKey(holder.privateJwk);
    const proofJwt = await signProofJwt(holderKey, holder.publicJwk, cNonce, credentialIssuer);

    let credential!: string;
    group('credential', () => {
        const res = http.post(
            `${issuerBase}/vci/credential`,
            JSON.stringify({
                ...credentialSelector,
                proofs: { jwt: [proofJwt] },
            }),
            {
                headers: {
                    Authorization: `Bearer ${walletAccessToken}`,
                    'Content-Type': 'application/json',
                },
                tags: stage(ctx, 'credential'),
            },
        );
        assertStatus(res, 200, 'credential');

        // OID4VCI 1.0 §8.3: { credentials: [{ credential }] }. Older shapes
        // are not accepted, so a regression of the response format fails here.
        const body = res.json() as { credentials?: Array<{ credential?: unknown }> };
        const first = body.credentials?.[0]?.credential;
        credential = typeof first === 'string' ? first : '';
        check(credential, {
            'credential: OID4VCI 1.0 credentials[].credential present': (c) => c.length > 0,
        });
        if (!credential) {
            fail(`credential: response without credential. Body: ${res.body}`);
        }
    });

    return { sessionId: offer.session, credential };
}

/**
 * Revoke all credentials of an issuance session. Exercises the status-list
 * write path: the bitstring is updated and the status list JWT re-signed.
 */
export function revokeCredential(ctx: FlowContext, adminToken: string, sessionId: string): void {
    group('revoke', () => {
        const res = http.post(
            `${ctx.baseUrl}/api/session/revoke`,
            JSON.stringify({ sessionId, status: 1 }),
            authParams(adminToken, stage(ctx, 'revoke')),
        );
        assertStatus(res, 204, 'revoke');
    });
}
