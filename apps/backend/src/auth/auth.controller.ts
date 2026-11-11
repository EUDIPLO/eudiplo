import {
    Body,
    Controller,
    Get,
    Headers,
    Post,
    UseGuards,
} from "@nestjs/common";
import {
    ApiBody,
    ApiConsumes,
    ApiExtraModels,
    ApiOperation,
    ApiResponse,
    ApiSecurity,
    ApiTags,
} from "@nestjs/swagger";
import { KeyResponseDto } from "../crypto/key/dto/key-response.dto.js";
import { JwtAuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { CallerResponseDto } from "./dto/caller-response.dto.js";
import { ClientCredentialsDto } from "./dto/client-credentials.dto.js";
import { OAuthTokenErrorResponseDto } from "./dto/oauth-token-error-response.dto.js";
import { OidcDiscoveryDto } from "./dto/oidc-discovery.dto.js";
import { RoleDto } from "./dto/role.dto.js";
import { TokenResponse } from "./dto/token-response.dto.js";
import { Token, TokenPayload } from "./token.decorator.js";

/**
 * Authentication Controller
 */
@ApiExtraModels(RoleDto)
@ApiTags("Authentication")
@Controller()
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    /**
     * OAuth2 Token endpoint - supports client credentials flow only
     * Accepts client credentials either in Authorization header (Basic auth) or request body
     * @param body
     * @param headers
     * @returns
     */
    @Post("api/oauth2/token")
    @ApiConsumes("application/x-www-form-urlencoded")
    @ApiBody({
        type: ClientCredentialsDto,
        examples: {
            client_credentials: {
                summary: "Client Credentials Flow",
                value: {
                    grant_type: "client_credentials",
                    client_id: "root",
                    client_secret: "root",
                },
            },
        },
    })
    @ApiResponse({
        status: 200,
        description: "OAuth2 token response",
        type: TokenResponse,
        examples: {
            success: {
                summary: "Successful response",
                value: {
                    access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                    token_type: "Bearer",
                    expires_in: 86400,
                    state: "abc123",
                },
            },
        },
    })
    @ApiResponse({
        status: 401,
        description: "Invalid client credentials",
        type: OAuthTokenErrorResponseDto,
    })
    getOAuth2Token(
        @Body() body: ClientCredentialsDto,
        @Headers() headers: any,
    ): Promise<TokenResponse> {
        return this.authService.getOAuth2Token(body, headers);
    }

    /**
     * The caller as the backend resolved it from the access token, so the web
     * client does not read roles and the tenant from the token itself.
     */
    @Get("auth/me")
    @UseGuards(JwtAuthGuard)
    @ApiSecurity("oauth2")
    @ApiOperation({
        summary: "Get the caller",
        description:
            "Returns the subject, tenant and roles the backend grants for the access token: with the built-in server the client's current roles, with an external OIDC provider those of the token's claims. Needs no role.",
    })
    @ApiResponse({
        status: 200,
        description: "The caller",
        type: CallerResponseDto,
    })
    @ApiResponse({
        status: 401,
        description: "Missing or invalid access token",
    })
    getCaller(@Token() user: TokenPayload): CallerResponseDto {
        return {
            subject: user.subject ?? null,
            tenantId: user.entity?.id ?? null,
            roles: user.roles,
        };
    }

    /**
     * Discovery of the management API: where API clients get tokens, and in
     * OIDC mode how the Web Client signs people in.
     */
    @Get(".well-known/oauth-authorization-server")
    @ApiOperation({
        summary: "OIDC Discovery Configuration",
        description:
            "Returns where API clients get access tokens for the management API (issuer, token endpoint, key set). In OIDC mode it also names the identity provider (`oidc_provider`) and, when single sign-on is set up, the Web Client's public client (`ui_client_id`).",
    })
    @ApiResponse({
        status: 200,
        description: "OIDC Discovery Configuration",
        schema: { type: "object", additionalProperties: true },
    })
    getOidcDiscovery(): OidcDiscoveryDto {
        return this.authService.getOidcDiscovery();
    }

    /**
     * Global JWKS endpoint for client credentials flow.
     * This provides the JSON Web Key Set for verifying tokens issued by this server.
     */
    @Get(".well-known/jwks.json")
    @ApiOperation({
        summary: "JSON Web Key Set",
        description: "Returns the JSON Web Key Set for token verification.",
    })
    @ApiResponse({
        status: 200,
        description: "JSON Web Key Set",
        type: KeyResponseDto,
    })
    getGlobalJwks(): KeyResponseDto {
        // For now, return an empty key set since the actual keys are tenant-specific
        // This can be enhanced later to include global signing keys if needed
        return {
            keys: [],
        };
    }
}
