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
    ApiBody,
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
    ChainedAsParRequestDto,
    ChainedAsParResponseDto,
    ChainedAsTokenRequestDto,
    ChainedAsTokenResponseDto,
    extractDpopJkt,
    renderWalletInvocationPage,
} from "../shared/index.js";
import { ChainedAsVpService } from "./chained-as-vp.service.js";

@ApiTags("Chained AS VP")
@Controller("issuers/:tenantId/chained-as-vp")
export class ChainedAsVpController {
    constructor(private readonly chainedAsVpService: ChainedAsVpService) {}

    @Public()
    @Post("par")
    @HttpCode(HttpStatus.CREATED)
    @ApiConsumes("application/x-www-form-urlencoded")
    @ApiOperation({
        summary: "Pushed Authorization Request",
        description:
            "Submit wallet authorization request parameters for the VP-backed AS.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
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
    @ApiBody({ type: ChainedAsParRequestDto })
    @ApiResponse({ status: 201, type: ChainedAsParResponseDto })
    @ApiResponse({ status: 400, type: ChainedAsErrorResponseDto })
    async par(
        @Param("tenantId") tenantId: string,
        @Body() body: ChainedAsParRequestDto,
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

        return this.chainedAsVpService.handlePar(
            tenantId,
            body,
            dpopJkt,
            clientAttestation,
        );
    }

    @Public()
    @Get("authorize")
    @ApiOperation({
        summary: "Authorization endpoint",
        description:
            "Validates the request_uri and returns a page whose link opens the OID4VP wallet request.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
    @ApiResponse({
        status: 200,
        description:
            "HTML page with a link that opens the OID4VP wallet invocation",
        content: { "text/html": { schema: { type: "string" } } },
    })
    @ApiResponse({ status: 400, type: ChainedAsErrorResponseDto })
    async authorize(
        @Param("tenantId") tenantId: string,
        @Query() query: ChainedAsAuthorizeQueryDto,
        @Headers("origin") origin: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        const walletUrl = await this.chainedAsVpService.handleAuthorize(
            tenantId,
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
    @ApiOperation({
        summary: "Verifier callback",
        description:
            "Receives the OID4VP verifier redirect and finishes the OAuth authorization flow.",
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
    @ApiResponse({ status: 400, type: ChainedAsErrorResponseDto })
    async vpCallback(
        @Param("tenantId") tenantId: string,
        @Query("cas") cas: string,
        @Query("response_code") responseCode?: string,
        @Query("error") error?: string,
        @Query("error_description") errorDescription?: string,
        @Res() res?: Response,
    ): Promise<void> {
        const redirectUrl =
            await this.chainedAsVpService.handleVerifierCallback(
                tenantId,
                cas,
                responseCode,
                error,
                errorDescription,
            );
        res!.redirect(redirectUrl);
    }

    @Public()
    @Post("token")
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "Token endpoint",
        description:
            "Exchanges the authorization code for an access token containing issuer_state.",
    })
    @ApiParam({ name: "tenantId", description: "Tenant identifier" })
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

        return this.chainedAsVpService.handleToken(
            tenantId,
            body,
            dpopJwt,
            clientAttestation,
        );
    }
}
