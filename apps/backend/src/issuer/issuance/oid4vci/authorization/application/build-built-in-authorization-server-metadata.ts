import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import type { Oid4vciSettings } from "../../oid4vci-settings.js";
import {
    findBuiltInAuthorizationServer,
    resolveRefreshTokenPolicy,
} from "../domain/token-grant-rules.js";
import { resolveWalletAttestationPolicy } from "../domain/wallet-attestation-policy.js";
import type { BuiltInAuthorizationServerConfiguration } from "../ports/built-in-authorization-server-configuration.js";
import type { OAuthAuthorizationServerFactory } from "../ports/oauth-authorization-server-factory.js";
import {
    buildAuthorizationServerMetadata,
    buildWalletAttestationMetadata,
    DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
} from "../shared/authorization-server-metadata.util.js";

/** Issuer identifier of the tenant's built-in authorization server. */
export function builtInAuthorizationServerIssuer(
    settings: Oid4vciSettings,
    tenantId: string,
): string {
    return `${settings.publicUrl}/issuers/${tenantId}`;
}

/** RFC 8414 metadata of the tenant's built-in authorization server. */
export class BuildBuiltInAuthorizationServerMetadata {
    constructor(
        private readonly configuration: BuiltInAuthorizationServerConfiguration,
        private readonly servers: OAuthAuthorizationServerFactory,
        private readonly settings: Oid4vciSettings,
    ) {}

    async execute(tenantId: string): Promise<AuthorizationServerMetadata> {
        const issuanceConfig =
            await this.configuration.issuanceConfiguration(tenantId);
        const walletAttestationPolicy = resolveWalletAttestationPolicy(
            issuanceConfig,
            findBuiltInAuthorizationServer(issuanceConfig),
        );
        const refreshTokenPolicy = resolveRefreshTokenPolicy(issuanceConfig);
        const authServer = builtInAuthorizationServerIssuer(
            this.settings,
            tenantId,
        );
        const statusListAggregationEndpoint =
            (await this.configuration.statusListAggregationEnabled(tenantId))
                ? `${authServer}/status-management/status-list-aggregation`
                : undefined;

        const metadata = buildAuthorizationServerMetadata({
            issuer: authServer,
            authorizationEndpoint: `${authServer}/authorize`,
            tokenEndpoint: `${authServer}/authorize/token`,
            pushedAuthorizationRequestEndpoint: `${authServer}/authorize/par`,
            jwksUri: `${this.settings.publicUrl}/.well-known/jwks.json/issuers/${tenantId}`,
            grantTypesSupported: refreshTokenPolicy.enabled
                ? [
                      "authorization_code",
                      "refresh_token",
                      "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                  ]
                : [
                      "authorization_code",
                      "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                  ],
            dpopSigningAlgValuesSupported:
                DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED,
            ...buildWalletAttestationMetadata(
                walletAttestationPolicy.walletAttestationRequired,
            ),
            additionalMetadata: {
                require_pushed_authorization_requests: true,
                authorization_response_iss_parameter_supported: true,
                interactive_authorization_endpoint: `${authServer}/authorize/interactive`,
                status_list_aggregation_endpoint: statusListAggregationEndpoint,
                challenge_endpoint: `${authServer}/authorize/challenge`,
            },
        });

        return this.servers
            .forTenant(tenantId)
            .createAuthorizationServerMetadata(
                metadata as unknown as AuthorizationServerMetadata,
            ) as AuthorizationServerMetadata;
    }
}
