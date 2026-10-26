/**
 * `setup()` helpers shared by the scenarios: obtain the operator token once,
 * generate the holder key pair, and issue the credentials the presentation
 * flow presents.
 */

import { requestAdminToken } from '../helpers.ts';
import { exportKeyPair, generateKeyPair } from '../crypto.ts';
import { type FlowContext, type HolderKeys, type WalletSetupData } from './context.ts';
import { issueCredential } from './issuance.ts';

/**
 * Prepare the wallet: token, holder key and `credentialCount` issued
 * credentials. With `CREDENTIAL_JWT` and `HOLDER_PRIVATE_JWK` set, the given
 * credential is used instead of issuing one (for deployments where the test
 * client may not issue).
 */
export async function setupWallet(
    ctx: FlowContext,
    credentialCount: number,
): Promise<WalletSetupData> {
    const setupCtx: FlowContext = { ...ctx, inSetup: true };
    const adminToken = requestAdminToken(
        ctx.baseUrl,
        ctx.clientId,
        ctx.clientSecret,
        { stage: 'setup' },
    );

    const external = externalCredential();
    if (external) {
        return { adminToken, holder: external.holder, credentials: [external.credential] };
    }

    const keyPair = await generateKeyPair();
    const holder: HolderKeys = await exportKeyPair(keyPair);

    const credentials: string[] = [];
    for (let i = 0; i < credentialCount; i++) {
        const issued = await issueCredential(setupCtx, adminToken.token, holder);
        credentials.push(issued.credential);
    }

    return { adminToken, holder, credentials };
}

function externalCredential(): { credential: string; holder: HolderKeys } | undefined {
    const credential = __ENV.CREDENTIAL_JWT;
    if (!credential) return undefined;
    const raw = __ENV.HOLDER_PRIVATE_JWK;
    if (!raw) {
        throw new Error('CREDENTIAL_JWT requires HOLDER_PRIVATE_JWK (the JWK bound in its cnf claim)');
    }
    const privateJwk = JSON.parse(raw) as JsonWebKey;
    const { d: _d, ...publicJwk } = privateJwk;
    return { credential, holder: { privateJwk, publicJwk } };
}
