import type { SecretUse } from "../../../../platform/secrets/domain/secret-use.js";

/**
 * How the upstream client secret of a chained authorization server is used:
 * by the tenant that owns the issuance configuration, sent to
 * `destination`. That is the upstream `issuer` when it is stored and, when
 * it is sent, both the issuer and the token endpoint its discovery document
 * names. The field names no server: its position in `authorizationServers`
 * changes with the list, so a grant is tied to the address instead.
 */
export function upstreamClientSecretUse(
    tenantId: string,
    destination: string,
): SecretUse {
    return {
        scope: { type: "tenant", tenantId },
        field: "IssuanceConfig:authorizationServers.*.upstream.clientSecret",
        destination,
    };
}
