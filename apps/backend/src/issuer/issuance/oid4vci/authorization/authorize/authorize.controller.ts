import {
    Body,
    Controller,
    Get,
    Header,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Req,
    Res,
} from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AuthorizeService } from "./authorize.service.js";
import { AuthorizeQueries } from "./dto/authorize-request.dto.js";
import { ParResponseDto } from "./dto/par-response.dto.js";

/**
 * Controller for the OpenID4VCI authorization endpoints.
 * This controller handles the authorization requests, token requests.
 */
@ApiTags("OID4VCI")
@Controller("issuers/:tenantId/authorize")
export class AuthorizeController {
    constructor(private readonly authorizeService: AuthorizeService) {}

    /**
     * Endpoint to handle the Authorization Request.
     * @param queries
     * @param res
     */
    @Get()
    async authorize(
        @Query() queries: AuthorizeQueries,
        @Res() res: Response,
        @Param("tenantId") tenantId: string,
    ) {
        const redirectUrl =
            await this.authorizeService.sendAuthorizationResponse(
                queries,
                tenantId,
            );
        res.redirect(redirectUrl);
    }

    /**
     * Endpoint to handle the Pushed Authorization Request (PAR).
     * @param body
     * @returns
     */
    @ApiBody({
        description: "Pushed Authorization Request",
        type: AuthorizeQueries,
    })
    @ApiConsumes("application/x-www-form-urlencoded")
    @Post("par")
    @HttpCode(HttpStatus.CREATED)
    @Header("Cache-Control", "no-store")
    async par(
        @Param("tenantId") tenantId: string,
        @Body() body: AuthorizeQueries,
        @Req() req: Request,
        @Headers("oauth-client-attestation") clientAttestationJwt?: string,
        @Headers("oauth-client-attestation-pop")
        clientAttestationPopJwt?: string,
    ): Promise<ParResponseDto> {
        const clientAttestation =
            clientAttestationJwt && clientAttestationPopJwt
                ? { clientAttestationJwt, clientAttestationPopJwt }
                : undefined;

        return this.authorizeService.handlePar(
            tenantId,
            body,
            req,
            clientAttestation,
        );
    }

    /**
     * Endpoint to validate the token request.
     * This endpoint is used to exchange the authorization code for an access token.
     * @param body
     * @param req
     * @returns
     */
    @Post("token")
    @HttpCode(HttpStatus.OK)
    @Header("Cache-Control", "no-store")
    token(
        @Body() body: any,
        @Req() req: Request,
        @Param("tenantId") tenantId: string,
    ): Promise<any> {
        return this.authorizeService.validateTokenRequest(body, req, tenantId);
    }

    /**
     * Client Attestation Challenge Endpoint.
     * Returns a nonce for inclusion in the Client Attestation PoP JWT.
     * @see OAuth2-ATCA07-8
     */
    @Post("challenge")
    @HttpCode(HttpStatus.OK)
    @Header("Cache-Control", "no-store")
    challenge(
        @Param("tenantId") tenantId: string,
    ): Promise<{ attestation_challenge: string }> {
        return this.authorizeService.challengeRequest(tenantId);
    }
}
