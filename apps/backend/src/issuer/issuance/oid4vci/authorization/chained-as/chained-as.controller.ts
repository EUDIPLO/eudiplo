import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Res,
} from "@nestjs/common";
import {
    ApiConsumes,
    ApiHeader,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { Public } from "../../../../../auth/public.decorator.js";
import {
    ChainedAsAuthorizeQueryDto,
    ChainedAsErrorResponseDto,
    ChainedAsParResponseDto,
    ChainedAsTokenRequestDto,
    ChainedAsTokenResponseDto,
} from "../shared/index.js";
import { ChainedAsService } from "./chained-as.service.js";

/**
 * Controller for Chained Authorization Server endpoints.
 *
 * Implements OAuth 2.0 AS endpoints where EUDIPLO acts as a facade,
 * delegating user authentication to an upstream OIDC provider while
 * issuing its own tokens containing issuer_state for session correlation.
 *
 * Flow:
 * 1. Wallet → PAR (receives request_uri)
 * 2. Wallet → Authorize (redirected to upstream OIDC)
 * 3. User authenticates at upstream OIDC
 * 4. Upstream → Callback (EUDIPLO exchanges code, redirects wallet with our code)
 * 5. Wallet → Token (receives EUDIPLO-issued access token with issuer_state)
 */
@ApiTags("Chained AS")
@Controller("issuers/:tenantId/chained-as")
export class ChainedAsController {
    constructor(private readonly chainedAsService: ChainedAsService) {}

    /**
     * Pushed Authorization Request (PAR) endpoint.
     * Wallets submit authorization parameters here before redirecting to authorize.
     */
    @Public()
    @Post("par")
    @HttpCode(HttpStatus.CREATED)
    @ApiConsumes("application/x-www-form-urlencoded")
    @ApiOperation({
        summary: "Pushed Authorization Request",
        description:
            "Submit authorization request parameters. Returns a request_uri for use at the authorization endpoint.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiHeader({
        name: "DPoP",
        required: false,
        description: "DPoP proof JWT",
    })
    @ApiHeader({
        name: "OAuth-Client-Attestation",
        required: false,
        description: "Wallet attestation JWT",
    })
    @ApiHeader({
        name: "OAuth-Client-Attestation-PoP",
        required: false,
        description: "Wallet attestation proof-of-possession JWT",
    })
    @ApiHeader({
        name: "OAuth-Client-Attestation",
        required: false,
        description: "Wallet attestation JWT",
    })
    @ApiHeader({
        name: "OAuth-Client-Attestation-PoP",
        required: false,
        description: "Wallet attestation proof-of-possession JWT",
    })
    @ApiResponse({
        status: 201,
        description: "PAR request accepted",
        type: ChainedAsParResponseDto,
    })
    @ApiResponse({
        status: 400,
        description: "Invalid request",
        type: ChainedAsErrorResponseDto,
    })
    async par(
        @Param("tenantId") tenantId: string,
        @Body() body: any,
        @Headers("dpop") dpopJwt?: string,
        @Headers("oauth-client-attestation") clientAttestationJwt?: string,
        @Headers("oauth-client-attestation-pop")
        clientAttestationPopJwt?: string,
    ): Promise<ChainedAsParResponseDto> {
        // Build client attestation object if both headers are provided
        const clientAttestation =
            clientAttestationJwt && clientAttestationPopJwt
                ? { clientAttestationJwt, clientAttestationPopJwt }
                : undefined;

        return this.chainedAsService.handlePar(
            tenantId,
            body,
            dpopJwt,
            clientAttestation,
        );
    }

    /**
     * Authorization endpoint.
     * Validates the request_uri and redirects to the upstream OIDC provider.
     */
    @Public()
    @Get("authorize")
    @ApiOperation({
        summary: "Authorization endpoint",
        description:
            "Validates the request_uri from PAR and redirects to the upstream OIDC provider for authentication.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiResponse({
        status: 302,
        description: "Redirect to upstream OIDC provider",
        headers: {
            Location: {
                description: "Redirect target",
                schema: { type: "string" },
            },
        },
    })
    @ApiResponse({
        status: 400,
        description: "Invalid request",
        type: ChainedAsErrorResponseDto,
    })
    async authorize(
        @Param("tenantId") tenantId: string,
        @Query() query: ChainedAsAuthorizeQueryDto,
        @Res() res: Response,
    ): Promise<void> {
        const redirectUrl = await this.chainedAsService.handleAuthorize(
            tenantId,
            query.client_id,
            query.request_uri,
        );
        res.redirect(redirectUrl);
    }

    /**
     * Callback endpoint for upstream OIDC provider.
     * Receives the authorization code from upstream and redirects the wallet.
     */
    @Public()
    @Get("callback")
    @ApiOperation({
        summary: "Upstream OIDC callback",
        description:
            "Receives the authorization response from the upstream OIDC provider, exchanges the code, and redirects back to the wallet.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiResponse({
        status: 302,
        description: "Redirect to wallet with authorization code",
        headers: {
            Location: {
                description: "Redirect target",
                schema: { type: "string" },
            },
        },
    })
    @ApiResponse({
        status: 400,
        description: "Invalid callback",
        type: ChainedAsErrorResponseDto,
    })
    async callback(
        @Param("tenantId") tenantId: string,
        @Res() res: Response,
        @Query("code") code?: string,
        @Query("state") state?: string,
        @Query("error") error?: string,
        @Query("error_description") errorDescription?: string,
    ): Promise<void> {
        const redirectUrl = await this.chainedAsService.handleUpstreamCallback(
            tenantId,
            code || "",
            state || "",
            error,
            errorDescription,
        );
        res.redirect(redirectUrl);
    }

    /**
     * Token endpoint.
     * Exchanges the authorization code for an access token.
     */
    @Public()
    @Post("token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "Token endpoint",
        description:
            "Exchanges the authorization code for an access token containing issuer_state.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiHeader({
        name: "DPoP",
        required: false,
        description: "DPoP proof JWT",
    })
    @ApiResponse({
        status: 200,
        description: "Token issued successfully",
        type: ChainedAsTokenResponseDto,
    })
    @ApiResponse({
        status: 400,
        description: "Invalid request",
        type: ChainedAsErrorResponseDto,
    })
    @ApiResponse({
        status: 401,
        description: "Invalid authorization code",
        type: ChainedAsErrorResponseDto,
    })
    async token(
        @Param("tenantId") tenantId: string,
        @Body() body: ChainedAsTokenRequestDto,
        @Headers("dpop") dpopJwt?: string,
        @Headers("oauth-client-attestation") clientAttestationJwt?: string,
        @Headers("oauth-client-attestation-pop")
        clientAttestationPopJwt?: string,
    ): Promise<ChainedAsTokenResponseDto> {
        const clientAttestation =
            clientAttestationJwt && clientAttestationPopJwt
                ? { clientAttestationJwt, clientAttestationPopJwt }
                : undefined;

        return this.chainedAsService.handleToken(
            tenantId,
            body,
            dpopJwt,
            clientAttestation,
        );
    }
}
