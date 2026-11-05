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
        if (this.jwtService.isUsingExternalOIDC()) {
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
        const settings = this.settings;
        const builtin = settings.mode === "builtin";
        // Another provider's endpoints come from its discovery document.
        const provider = this.issuerMetadata;
        const tokenEndpoint = builtin
            ? `${publicUrl}/api/oauth2/token`
            : (provider?.token_endpoint ??
              `${settings.issuer}/protocol/openid-connect/token`);

        return {
            issuer: builtin ? publicUrl : settings.issuer,
            token_endpoint: tokenEndpoint,
            jwks_uri:
                provider?.jwks_uri ?? `${publicUrl}/.well-known/jwks.json`,
            response_types_supported: ["token"],
            grant_types_supported: ["client_credentials"],
            // The Web Client signs in to other providers with client
            // credentials only, so it offers single sign-on just for Keycloak.
            ...(settings.mode === "keycloak" && {
                ui_client_id: settings.uiClientId,
            }),
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
}
