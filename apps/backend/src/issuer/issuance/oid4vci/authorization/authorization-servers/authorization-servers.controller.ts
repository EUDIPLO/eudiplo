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
    extractDpopJkt,
    renderWalletInvocationPage,
} from "../shared/index.js";
import { AuthorizationServersService } from "./authorization-servers.service.js";

@ApiTags("Authorization Servers")
@Controller("issuers/:tenantId/authorization-servers/:authorizationServerId")
export class AuthorizationServersController {
    constructor(
        private readonly authorizationServersService: AuthorizationServersService,
    ) {}

    @Public()
    @Post("par")
    @HttpCode(HttpStatus.CREATED)
    @ApiConsumes("application/x-www-form-urlencoded")
    @ApiOperation({ summary: "Pushed Authorization Request" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({
        name: "authorizationServerId",
        description: "Authorization server identifier",
    })
    @ApiHeader({ name: "DPoP", required: false, description: "DPoP proof JWT" })
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
    @ApiResponse({ status: 201, type: ChainedAsParResponseDto })
    @ApiResponse({ status: 400, type: ChainedAsErrorResponseDto })
    async par(
        @Param("tenantId") tenantId: string,
        @Param("authorizationServerId") authorizationServerId: string,
        @Body() body: any,
        @Headers("dpop") dpopJwt?: string,
        @Headers("oauth-client-attestation") clientAttestationJwt?: string,
        @Headers("oauth-client-attestation-pop")
        clientAttestationPopJwt?: string,
    ): Promise<ChainedAsParResponseDto> {
        const dpopJkt = dpopJwt ? extractDpopJkt(dpopJwt) : undefined;
        const clientAttestation =
            clientAttestationJwt && clientAttestationPopJwt
                ? { clientAttestationJwt, clientAttestationPopJwt }
                : undefined;

        return this.authorizationServersService.handlePar(
            tenantId,
            authorizationServerId,
            body,
            dpopJkt,
            clientAttestation,
        );
    }

    @Public()
    @Get("authorize")
    @ApiOperation({ summary: "Authorization endpoint" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({
        name: "authorizationServerId",
        description: "Authorization server identifier",
    })
    @ApiResponse({
        status: 200,
        description:
            "HTML page with a link that opens the OID4VP wallet invocation",
        content: { "text/html": { schema: { type: "string" } } },
    })
    async authorize(
        @Param("tenantId") tenantId: string,
        @Param("authorizationServerId") authorizationServerId: string,
        @Query() query: ChainedAsAuthorizeQueryDto,
        @Headers("origin") origin: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        const walletUrl =
            await this.authorizationServersService.handleAuthorize(
                tenantId,
                authorizationServerId,
                query.client_id,
                query.request_uri,
                origin,
            );
        res.set("Cache-Control", "no-store")
            .type("html")
            .send(renderWalletInvocationPage(walletUrl));
    }

    @Public()
    @Get("vp-callback")
    @ApiOperation({ summary: "OID4VP callback" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({
        name: "authorizationServerId",
        description: "Authorization server identifier",
    })
    @ApiResponse({
        status: 302,
        description: "Redirect to wallet with authorization code",
    })
    async vpCallback(
        @Param("tenantId") tenantId: string,
        @Param("authorizationServerId") authorizationServerId: string,
        @Query("cas") chainedAsSessionId: string,
        @Query("response_code") responseCode?: string,
        @Query("error") error?: string,
        @Query("error_description") errorDescription?: string,
        @Res() res?: Response,
    ): Promise<void> {
        const redirectUrl =
            await this.authorizationServersService.handleVerifierCallback(
                tenantId,
                authorizationServerId,
                chainedAsSessionId,
                responseCode,
                error,
                errorDescription,
            );
        res!.redirect(redirectUrl);
    }

    @Public()
    @Post("token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Token endpoint" })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiParam({
        name: "authorizationServerId",
        description: "Authorization server identifier",
    })
    @ApiHeader({ name: "DPoP", required: false, description: "DPoP proof JWT" })
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
    @ApiResponse({ status: 200, type: ChainedAsTokenResponseDto })
    @ApiResponse({ status: 400, type: ChainedAsErrorResponseDto })
    async token(
        @Param("tenantId") tenantId: string,
        @Param("authorizationServerId") authorizationServerId: string,
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

        return this.authorizationServersService.handleToken(
            tenantId,
            authorizationServerId,
            body,
            dpopJwt,
            clientAttestation,
        );
    }
}
