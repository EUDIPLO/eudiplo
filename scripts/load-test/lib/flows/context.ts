/**
 * Shared configuration for all flows, read from the environment that
 * `run-all.sh` passes to k6.
 */

import { thinkTimeRange } from '../../k6.config.ts';
import type { AccessToken } from '../helpers.ts';

export interface FlowContext {
    baseUrl: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
    /** Credential configuration offered by the issuance flow. */
    credentialConfigId: string;
    /** Presentation configuration used by the presentation flow. */
    requestId: string;
    /** Simulated user pauses between operator and wallet steps. */
    think: { min: number; max: number };
    /**
     * True while running inside `setup()`. Requests made there are tagged
     * `stage:setup` so they do not count against the per-stage thresholds
     * of the measured flow.
     */
    inSetup: boolean;
}

export function flowContext(): FlowContext {
    return {
        baseUrl: __ENV.BASE_URL || 'http://localhost:3000',
        tenantId: __ENV.TENANT_ID || 'demo',
        clientId: __ENV.CLIENT_ID || 'test-client',
        clientSecret: __ENV.CLIENT_SECRET || 'test-client-secret',
        credentialConfigId: __ENV.CREDENTIAL_CONFIG_ID || 'pid',
        requestId: __ENV.REQUEST_ID || 'age-over-18',
        think: thinkTimeRange(),
        inSetup: false,
    };
}

/** Request tags for a flow stage. */
export function stage(ctx: FlowContext, name: string): Record<string, string> {
    return { stage: ctx.inSetup ? 'setup' : name };
}

/** Holder key pair as serialisable JWKs (CryptoKey cannot cross setup → VU). */
export interface HolderKeys {
    privateJwk: JsonWebKey;
    publicJwk: JsonWebKey;
}

/** Data `setup()` hands to every VU. */
export interface WalletSetupData {
    adminToken: AccessToken;
    holder: HolderKeys;
    /** Issued SD-JWT VCs (with disclosures) the presentation flow can present. */
    credentials: string[];
}
