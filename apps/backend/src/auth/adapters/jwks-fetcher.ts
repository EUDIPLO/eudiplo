import type { OutboundUrlPolicyService } from "../../webhook/outbound-url-policy.service.js";

/** Limits of one request for the key set. */
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;

/**
 * Fetches the identity provider's key set for jwks-rsa through the outbound
 * URL policy, bounded in time and size and without following redirects. The
 * origins the operator configured skip the policy, as for the discovery
 * document; a key set elsewhere, which only the discovery document names, is
 * checked like any other outbound URL.
 */
export function jwksFetcher(
    outboundUrlPolicy: OutboundUrlPolicyService,
    trustedOrigins: string[],
): (jwksUri: string) => Promise<{ keys: unknown }> {
    return async (jwksUri) => {
        const response = await outboundUrlPolicy.get(jwksUri, {
            timeoutMs: TIMEOUT_MS,
            maxBytes: MAX_BYTES,
            headers: { accept: "application/json" },
            trustedOrigins,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `The key set at ${jwksUri} answered with status code ${response.status}`,
            );
        }
        return JSON.parse(response.body);
    };
}
