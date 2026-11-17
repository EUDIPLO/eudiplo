import { NotFoundError } from "../../../shared/domain/not-found-error.js";
import { ACR_CROSS_DEVICE, ACR_SAME_DEVICE } from "../domain/oidc-sign-in.js";
import { oidcIssuer } from "../oidc-provider-settings.js";
import type { IdTokenSigner } from "../ports/id-token-signer.js";
import type { OidcClientRepository } from "../ports/oidc-client.repository.js";

/** The tenant has no OpenID Connect client, so it offers no provider. */
export class OidcProviderNotEnabled extends NotFoundError {
    constructor() {
        super("The OpenID Provider is not enabled for this tenant");
    }
}

/**
 * The tenant's OpenID Provider metadata (OpenID Connect Discovery 1.0
 * Section 3), offered once the tenant has a client.
 */
export class BuildOidcDiscovery {
    constructor(
        private readonly clients: Pick<OidcClientRepository, "existsForTenant">,
        private readonly signer: Pick<IdTokenSigner, "algorithms">,
        private readonly publicUrl: string,
    ) {}

    /** Throws {@link OidcProviderNotEnabled} for a tenant without clients. */
    async assertEnabled(tenantId: string): Promise<void> {
        if (!(await this.clients.existsForTenant(tenantId))) {
            throw new OidcProviderNotEnabled();
        }
    }

    async execute(tenantId: string): Promise<Record<string, unknown>> {
        await this.assertEnabled(tenantId);
        const issuer = oidcIssuer(this.publicUrl, tenantId);
        return {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            pushed_authorization_request_endpoint: `${issuer}/par`,
            jwks_uri: `${issuer}/jwks`,
            scopes_supported: ["openid"],
            response_types_supported: ["code"],
            response_modes_supported: ["query"],
            grant_types_supported: ["authorization_code"],
            // No subject is shared between clients or sign-ins.
            subject_types_supported: ["pairwise"],
            // The algorithm of the tenant's key; RS256 is not offered.
            id_token_signing_alg_values_supported:
                await this.signer.algorithms(tenantId),
            token_endpoint_auth_methods_supported: [
                "client_secret_basic",
                "client_secret_post",
            ],
            code_challenge_methods_supported: ["S256"],
            acr_values_supported: [ACR_SAME_DEVICE, ACR_CROSS_DEVICE],
            claims_supported: [
                "iss",
                "sub",
                "aud",
                "exp",
                "iat",
                "auth_time",
                "nonce",
                "acr",
                "credentials",
            ],
            claims_parameter_supported: false,
            request_parameter_supported: false,
            request_uri_parameter_supported: false,
            // One document serves every client; a `secure` client that skips
            // the push is still refused.
            require_pushed_authorization_requests: false,
            authorization_response_iss_parameter_supported: true,
        };
    }
}
