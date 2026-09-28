import {
    Body,
    ConflictException,
    Controller,
    Get,
    Header,
    Headers,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    Param,
    Post,
    Query,
    Req,
    Res,
} from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { HttpMethod, RequestLike } from "@openid4vc/oauth2";
import type { Request, Response } from "express";
import { tokenErrorResponse } from "../../exceptions/token-error.exception.js";
import {
    OID4VCI_SETTINGS,
    type Oid4vciSettings,
} from "../../oid4vci-settings.js";
import { normalizeRequestHeaders } from "../../util.js";
import {
    AuthorizePushedRequest,
    RequestUriMissing,
} from "../application/authorize-pushed-request.js";
import { ExchangeAccessToken } from "../application/exchange-access-token.js";
import { PushAuthorizationRequest } from "../application/push-authorization-request.js";
import { OAuthError } from "../domain/oauth-error.js";
import { AuthorizeService } from "./authorize.service.js";
import { AuthorizeQueries } from "./dto/authorize-request.dto.js";
import { ParResponseDto } from "./dto/par-response.dto.js";

/**
 * Controller for the OpenID4VCI authorization endpoints of the built-in
 * authorization server: authorization, PAR, token and challenge.
 * Maps application {@link OAuthError}s to OAuth error responses.
 */
@ApiTags("OID4VCI")
@Controller("issuers/:tenantId/authorize")
export class AuthorizeController {
    private readonly logger = new Logger(AuthorizeController.name);

    constructor(
        private readonly authorizeService: AuthorizeService,
        private readonly authorizePushedRequest: AuthorizePushedRequest,
        private readonly pushAuthorizationRequest: PushAuthorizationRequest,
        private readonly exchangeAccessToken: ExchangeAccessToken,
        @Inject(OID4VCI_SETTINGS) private readonly settings: Oid4vciSettings,
    ) {}

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
        const redirectUrl = await this.authorizePushedRequest
            .execute(tenantId, queries)
            .catch((error) => {
                if (error instanceof RequestUriMissing) {
                    throw new ConflictException(error.message);
                }
                throw this.toHttpError(error);
            });
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
    par(
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
        const dpop = req.headers.dpop;

        return this.pushAuthorizationRequest
            .execute({
                tenantId,
                body,
                request: this.requestLike(req),
                dpopJwt: Array.isArray(dpop) ? dpop[0] : dpop,
                clientAttestation,
            })
            .catch((error) => {
                throw this.toHttpError(error);
            });
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
        return this.exchangeAccessToken
            .execute({ tenantId, body, request: this.requestLike(req) })
            .catch((error) => {
                throw this.toHttpError(error);
            });
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

    /** The request as the client sent it, for DPoP `htu` and header checks. */
    private requestLike(req: Request): RequestLike {
        return {
            method: req.method as HttpMethod,
            url: `${this.settings.publicUrl}${req.url}`,
            headers: normalizeRequestHeaders(req.headers),
        };
    }

    private toHttpError(error: unknown): unknown {
        if (!(error instanceof OAuthError)) {
            return error;
        }
        if (error.logDetail && error.cause !== undefined) {
            this.logger.error(error.logDetail, error.cause);
        } else if (error.logDetail) {
            this.logger.warn(error.logDetail);
        }
        return tokenErrorResponse(error);
    }
}
