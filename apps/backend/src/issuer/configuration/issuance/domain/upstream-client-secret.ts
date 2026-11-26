import type { SecretUse } from "../../../../platform/secrets/domain/secret-use.js";

/**
 * How the upstream client secret of a chained authorization server is used:
 * by the tenant that owns the issuance configuration, in the server at
 * `index` of `authorizationServers`, sent to `destination`. That is the
 * upstream `issuer` when it is stored and, when it is sent, both the issuer
 * and the token endpoint its discovery document names.
 */
export function upstreamClientSecretUse(
    tenantId: string,
    index: number,
    destination: string,
): SecretUse {
    return {
        scope: { type: "tenant", tenantId },
        field: `IssuanceConfig:authorizationServers.${index}.upstream.clientSecret`,
        destination,
    };
}
