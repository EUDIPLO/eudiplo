import type KeycloakAdminClient from "@keycloak/keycloak-admin-client";

/** Client scope that puts `OIDC_AUDIENCE` into access tokens. */
export const AUDIENCE_SCOPE = "eudiplo-audience";

function audienceMapper(audience: string) {
    return {
        name: AUDIENCE_SCOPE,
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
        config: {
            "included.custom.audience": audience,
            "access.token.claim": "true",
            "id.token.claim": "false",
            "introspection.token.claim": "true",
        },
    };
}

/**
 * Creates the client scope {@link AUDIENCE_SCOPE} with a mapper that adds
 * `audience` to access tokens, or brings the mapper of an existing scope up
 * to date, and returns the scope's ID.
 */
export async function ensureAudienceScope(
    kc: KeycloakAdminClient,
    audience: string,
): Promise<string> {
    const mapper = audienceMapper(audience);
    const scope = await kc.clientScopes.findOneByName({ name: AUDIENCE_SCOPE });
    if (!scope?.id) {
        const { id } = await kc.clientScopes.create({
            name: AUDIENCE_SCOPE,
            description: "Adds the EUDIPLO audience to access tokens",
            protocol: "openid-connect",
            attributes: { "include.in.token.scope": "false" },
            protocolMappers: [mapper],
        });
        return id;
    }
    const current = (
        await kc.clientScopes.listProtocolMappers({ id: scope.id })
    ).find((existing) => existing.name === mapper.name);
    if (!current?.id) {
        await kc.clientScopes.addProtocolMapper({ id: scope.id }, mapper);
    } else if (current.config?.["included.custom.audience"] !== audience) {
        await kc.clientScopes.updateProtocolMapper(
            { id: scope.id, mapperId: current.id },
            { ...mapper, id: current.id },
        );
    }
    return scope.id;
}
