interface AuthorizationServerMetadataBuildOptions {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    pushedAuthorizationRequestEndpoint: string;
    jwksUri: string;
    grantTypesSupported: readonly string[];
    tokenEndpointAuthMethodsSupported: readonly string[];
    responseTypesSupported?: readonly string[];
    authorizationDetailsTypesSupported?: readonly string[];
    codeChallengeMethodsSupported?: readonly string[];
    dpopSigningAlgValuesSupported?: readonly string[];
    clientAttestationSigningAlgValuesSupported?: readonly string[];
    clientAttestationPopSigningAlgValuesSupported?: readonly string[];
    additionalMetadata?: Record<string, unknown>;
}

const DEFAULT_CODE_CHALLENGE_METHODS_SUPPORTED = ["S256"] as const;

export const DEFAULT_DPOP_SIGNING_ALG_VALUES_SUPPORTED = [
    "ES256",
    "ES384",
    "ES512",
] as const;

const DEFAULT_CLIENT_ATTESTATION_SIGNING_ALG_VALUES_SUPPORTED = [
    "ES256",
] as const;

const DEFAULT_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = [
    "attest_jwt_client_auth",
    "none",
] as const;

export function buildWalletAttestationMetadata(
    walletAttestationRequired: boolean,
): {
    tokenEndpointAuthMethodsSupported: readonly string[];
    clientAttestationSigningAlgValuesSupported?: readonly string[];
    clientAttestationPopSigningAlgValuesSupported?: readonly string[];
} {
    return {
        tokenEndpointAuthMethodsSupported: walletAttestationRequired
            ? [...DEFAULT_TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED]
            : ["none"],
        clientAttestationSigningAlgValuesSupported: walletAttestationRequired
            ? [...DEFAULT_CLIENT_ATTESTATION_SIGNING_ALG_VALUES_SUPPORTED]
            : undefined,
        clientAttestationPopSigningAlgValuesSupported: walletAttestationRequired
            ? [...DEFAULT_CLIENT_ATTESTATION_SIGNING_ALG_VALUES_SUPPORTED]
            : undefined,
    };
}

export function buildAuthorizationServerMetadata(
    options: AuthorizationServerMetadataBuildOptions,
): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
        issuer: options.issuer,
        authorization_endpoint: options.authorizationEndpoint,
        token_endpoint: options.tokenEndpoint,
        pushed_authorization_request_endpoint:
            options.pushedAuthorizationRequestEndpoint,
        jwks_uri: options.jwksUri,
        response_types_supported: options.responseTypesSupported ?? ["code"],
        grant_types_supported: options.grantTypesSupported,
        authorization_details_types_supported:
            options.authorizationDetailsTypesSupported ?? ["openid_credential"],
        token_endpoint_auth_methods_supported:
            options.tokenEndpointAuthMethodsSupported,
        code_challenge_methods_supported:
            options.codeChallengeMethodsSupported ?? [
                ...DEFAULT_CODE_CHALLENGE_METHODS_SUPPORTED,
            ],
        dpop_signing_alg_values_supported:
            options.dpopSigningAlgValuesSupported,
    };

    if (options.clientAttestationSigningAlgValuesSupported) {
        metadata.client_attestation_signing_alg_values_supported =
            options.clientAttestationSigningAlgValuesSupported;
    }

    if (options.clientAttestationPopSigningAlgValuesSupported) {
        metadata.client_attestation_pop_signing_alg_values_supported =
            options.clientAttestationPopSigningAlgValuesSupported;
    }

    if (options.additionalMetadata) {
        Object.assign(metadata, options.additionalMetadata);
    }

    return metadata;
}
