import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AUTH_SETTINGS, type AuthSettings } from "./auth-settings.js";
import { InternalClientsProvider } from "./client/adapters/internal-clients.service.js";
import { CLIENTS_PROVIDER } from "./client/client.provider.js";
import { OidcDiscoveryDto } from "./dto/oidc-discovery.dto.js";
import { TokenResponse } from "./dto/token-response.dto.js";
import { ACCESS_TOKEN_LIFETIME_SECONDS, JwtService } from "./jwt.service.js";
import {
    OIDC_ISSUER_METADATA,
    type OidcIssuerMetadata,
} from "./ports/oidc-issuer-metadata.js";
import { InternalTokenPayload } from "./token.decorator.js";

/**
 * Authentication Service
 */
@Injectable()
export class AuthService {
    /**
     * Constructor for AuthService
     * @param jwtService
     * @param tenantService
     * @param configService
     */
    constructor(
        private readonly jwtService: JwtService,
        @Inject(CLIENTS_PROVIDER)
        private readonly clients: InternalClientsProvider,
        private readonly configService: ConfigService,
        @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
        @Inject(OIDC_ISSUER_METADATA)
        private readonly issuerMetadata: OidcIssuerMetadata | null,
    ) {}

    /**
     * Get OAuth2 token
     * @param body
     * @param headers
     * @returns
     */
    async getOAuth2Token(body: any, headers: any): Promise<TokenResponse> {
        if (this.settings.mode !== "builtin") {
            throw new UnauthorizedException(
                "OAuth2 token endpoint is not available when using external OIDC provider. Use your external OIDC provider for authentication.",
            );
        }

        // Only support client credentials flow (default if not specified)
        const grantType = body.grant_type || "client_credentials";
        if (grantType !== "client_credentials") {
            throw new UnauthorizedException(
                "Only client_credentials grant type is supported",
            );
        }

        let clientId: string;
        let clientSecret: string;

        // Try to extract credentials from Authorization header (Basic auth)
        const authHeader = headers.authorization;
        if (authHeader && authHeader.startsWith("Basic ")) {
            try {
                const base64Credentials = authHeader.substring(6);
                const credentials = Buffer.from(
                    base64Credentials,
                    "base64",
                ).toString("utf-8");
                const [id, secret] = credentials.split(":");
                clientId = decodeURI(id);
                clientSecret = decodeURI(secret);
            } catch {
                throw new UnauthorizedException(
                    "Invalid Authorization header format",
                );
            }
        } else {
            // Fall back to request body
            clientId = body.client_id;
            clientSecret = body.client_secret;
        }

        if (!clientId || !clientSecret) {
            throw new UnauthorizedException(
                "Client credentials must be provided either in Authorization header (Basic auth) or request body",
            );
        }

        const client = await this.clients.validateClientCredentials(
            clientId,
            clientSecret,
        );

        if (!client) {
            throw new UnauthorizedException("Invalid client credentials");
        }

        const payload: InternalTokenPayload = {
            roles: client.roles,
            tenant_id: client.tenantId!,
            ...(client.tokensValidAfter && {
                credentials_at: client.tokensValidAfter.getTime(),
            }),
        };

        const access_token = await this.jwtService.generateToken(payload, {
            expiresInSeconds: ACCESS_TOKEN_LIFETIME_SECONDS,
            audience: "eudiplo-service",
            //TODO: check if the clientId should be saved here or somewhere else like in client_id
            subject: clientId,
        });

        // No refresh token: the client credentials grant gets a new access
        // token with the credentials (RFC 6749, section 4.4.3).
        return {
            access_token,
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
            state: body.state,
        };
    }

    /**
     * Get OIDC Discovery configuration
     * @returns OIDC Discovery configuration
     */
    getOidcDiscovery(): OidcDiscoveryDto {
        const publicUrl = this.configService.getOrThrow<string>("PUBLIC_URL");

        return {
            ...this.authorizationServer(publicUrl),
            response_types_supported: ["token"],
            grant_types_supported: ["client_credentials"],
            token_endpoint_auth_methods_supported: [
                "client_secret_basic",
                "client_secret_post",
            ],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["ES256"],
            scopes_supported: ["openid"],
            claims_supported: ["iss", "sub", "aud", "exp", "iat"],
            service_documentation: "https://docs.eudiplo.dev/",
        };
    }

    /** The issuer and endpoints of the server that issues the access tokens. */
    private authorizationServer(
        publicUrl: string,
    ): Pick<
        OidcDiscoveryDto,
        | "issuer"
        | "token_endpoint"
        | "jwks_uri"
        | "ui_client_id"
        | "oidc_provider"
    > {
        const settings = this.settings;
        switch (settings.mode) {
            case "builtin":
                return {
                    issuer: publicUrl,
                    token_endpoint: `${publicUrl}/api/oauth2/token`,
                    jwks_uri: `${publicUrl}/.well-known/jwks.json`,
                };
            case "keycloak":
                // The key set is EUDIPLO's own, as before.
                return {
                    issuer: settings.issuer,
                    token_endpoint: `${settings.issuer}/protocol/openid-connect/token`,
                    jwks_uri: `${publicUrl}/.well-known/jwks.json`,
                    ui_client_id: settings.uiClientId,
                    oidc_provider: "keycloak",
                };
            case "generic": {
                // From the provider's discovery document. The operator creates
                // the Web Client's public client at the provider.
                const provider = this.issuerMetadata;
                if (!provider) {
                    throw new Error(
                        "The OIDC discovery document was not loaded for OIDC_PROVIDER=generic",
                    );
                }
                return {
                    issuer: settings.issuer,
                    token_endpoint: provider.token_endpoint,
                    jwks_uri: provider.jwks_uri,
                    ui_client_id: settings.uiClientId,
                    oidc_provider: "generic",
                };
            }
        }
    }
}
