import {
    Body,
    Controller,
    ForbiddenException,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Req,
    Res,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Role } from "../../../../../auth/roles/role.enum.js";
import { Secured } from "../../../../../auth/secure.decorator.js";
import {
    Token,
    type TokenPayload,
} from "../../../../../auth/token.decorator.js";
import type { Oid4vciRequestContext } from "../../request-context.js";
import {
    InteractiveAuthorizationCodeResponseDto,
    InteractiveAuthorizationErrorResponseDto,
    InteractiveAuthorizationOpenid4vpResponseDto,
    InteractiveAuthorizationRedirectToWebResponseDto,
    InteractiveAuthorizationRequestDto,
} from "./dto/interactive-authorization.dto.js";
import { InteractiveAuthorizationService } from "./interactive-authorization.service.js";

/**
 * Controller for the Interactive Authorization Endpoint (IAE).
 *
 * The IAE enables an interactive authorization flow during credential issuance,
 * allowing the issuer to request verifiable presentations from the wallet
 * before issuing credentials.
 *
 * This implements the OID4VCI 1.1 Interactive Authorization Endpoint specification.
 *
 * @see https://openid.net/specs/openid-4-verifiable-credential-issuance-1_1.html
 */
@ApiTags("OID4VCI", "Interactive Authorization")
@Controller("issuers/:tenantId/authorize/interactive")
export class InteractiveAuthorizationController {
    constructor(
        private readonly interactiveAuthorizationService: InteractiveAuthorizationService,
    ) {}

    /**
     * Interactive Authorization Endpoint.
     *
     * Handles both initial and follow-up interactive authorization requests.
     *
     * Initial requests include `interaction_types_supported` to indicate which
     * interaction methods the wallet supports (e.g., openid4vp_presentation, redirect_to_web).
     *
     * Follow-up requests include `auth_session` and either `openid4vp_response` or `code_verifier`
     * depending on the interaction type used.
     *
     * @param body The interactive authorization request body
     * @param req The Express request
     * @param res The Express response
     * @param tenantId The tenant identifier
     * @param origin The request origin header
     * @returns Interactive authorization response (interaction request or authorization code)
     */
    @Post()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "Interactive Authorization Endpoint",
        description: `
Handles interactive authorization requests during credential issuance.

**Initial Request:**
- Contains \`interaction_types_supported\` (e.g., "openid4vp_presentation,redirect_to_web")
- Response will indicate required interaction (OpenID4VP presentation or web redirect)

**Follow-up Request:**
- Contains \`auth_session\` from previous response
- Contains \`openid4vp_response\` (for presentation flow) or \`code_verifier\` (for web flow)
- Response will contain authorization code on success
        `,
    })
    @ApiBody({
        description: "Interactive authorization request",
        type: InteractiveAuthorizationRequestDto,
    })
    @ApiResponse({
        status: 200,
        description: "Authorization code response (successful completion)",
        type: InteractiveAuthorizationCodeResponseDto,
    })
    @ApiResponse({
        status: 200,
        description: "OpenID4VP interaction required",
        type: InteractiveAuthorizationOpenid4vpResponseDto,
    })
    @ApiResponse({
        status: 200,
        description: "Web redirect interaction required",
        type: InteractiveAuthorizationRedirectToWebResponseDto,
    })
    @ApiResponse({
        status: 400,
        description: "Error response",
        type: InteractiveAuthorizationErrorResponseDto,
    })
    async interactiveAuthorization(
        @Body() body: InteractiveAuthorizationRequestDto,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
        @Param("tenantId") tenantId: string,
        @Headers("origin") origin?: string,
    ) {
        const requestOrigin = origin || req.headers.referer || "";
        const requestContext: Oid4vciRequestContext = {
            body: req.body,
            contentType: req.headers["content-type"] ?? "",
            headers: req.headers,
            method: req.method,
            url: req.url,
        };

        const response =
            await this.interactiveAuthorizationService.handleRequest(
                body,
                requestContext,
                tenantId,
                requestOrigin,
            );

        // If the response contains an error, set the status to 400
        if ("error" in response) {
            res.status(HttpStatus.BAD_REQUEST);
        }

        return response;
    }

    /**
     * Complete web authorization.
     *
     * Called after the user completes web-based authorization to mark
     * the session as ready for code exchange.
     *
     * @param authSession The auth session identifier
     * @param tenantId The tenant identifier
     * @returns Success indicator
     */
    @Post("complete-web-auth/:authSession")
    @Secured([Role.IssuanceOffer])
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: "Complete web authorization",
        description:
            "Called by the issuer's backend with a management API token of the tenant: marks the redirect_to_web step of an auth session as completed after the user interaction.",
    })
    @ApiResponse({
        status: 200,
        description: "Web authorization marked as completed",
    })
    @ApiResponse({
        status: 401,
        description: "Missing or invalid management API token",
    })
    @ApiResponse({
        status: 403,
        description: "The token belongs to another tenant",
    })
    @ApiResponse({
        status: 404,
        description: "Auth session not found",
    })
    async completeWebAuth(
        @Param("authSession") authSession: string,
        @Param("tenantId") tenantId: string,
        @Token() token: TokenPayload,
    ) {
        // Only the tenant's backend may complete a web interaction; the
        // wallet knows the auth_session and must not complete it itself.
        if (token.entity?.id !== tenantId) {
            throw new ForbiddenException(
                "The token does not belong to this tenant",
            );
        }
        const success =
            await this.interactiveAuthorizationService.completeWebAuthorization(
                authSession,
                tenantId,
            );

        if (!success) {
            return {
                error: "not_found",
                error_description:
                    "Auth session not found or already completed",
            };
        }

        return { success: true };
    }
}
