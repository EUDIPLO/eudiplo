import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Param,
    Post,
} from "@nestjs/common";
import { ApiParam, ApiTags } from "@nestjs/swagger";
import { AuthorizationResponse } from "./dto/authorization-response.dto.js";
import { Oid4vpService } from "./oid4vp.service.js";

/**
 * Controller for handling OID4VP (OpenID for Verifiable Presentations) requests.
 * Per OID4VP spec section 5.10.1, Request URI responses must use Content-Type: application/oauth-authz-req+jwt
 */
@ApiTags("OID4VP")
@Controller("presentations/:sessionId/oid4vp")
@ApiParam({
    name: "sessionId",
    required: true,
    description:
        "The `walletNonce` from `request_uri` or `response_uri`; the session ID is not accepted.",
})
export class Oid4vpController {
    /**
     * Constructor for the Oid4vpController.
     * @param oid4vpService - Instance of Oid4vpService for handling OID4VP operations.
     */
    constructor(private readonly oid4vpService: Oid4vpService) {}

    /**
     * Returns the authorization request for a given requestId and session.
     * Returns the cached request JWT if available, otherwise generates a new one.
     * Per OID4VP spec section 5.10.1: Response MUST use Content-Type: application/oauth-authz-req+jwt
     * @param session
     * @param req
     * @returns
     */
    @Get("request")
    @Header("Content-Type", "application/oauth-authz-req+jwt")
    getRequestWithSession(@Param("sessionId") sessionId: string) {
        return this.oid4vpService.getAuthorizationRequest(sessionId);
    }

    /**
     * Returns the authorization request for a given requestId and session, but does not redirect in the end.
     * Returns the cached request JWT if available, otherwise generates a new one.
     * Per OID4VP spec section 5.10.1: Response MUST use Content-Type: application/oauth-authz-req+jwt
     * @param sessionId
     * @param req
     * @returns
     */
    @Get("request/no-redirect")
    @Header("Content-Type", "application/oauth-authz-req+jwt")
    getRequestNoRedirectWithSession(@Param("sessionId") sessionId: string) {
        return this.oid4vpService.getAuthorizationRequest(sessionId, true);
    }

    /**
     * Returns the authorization request for a given requestId and session.
     * Returns the cached request JWT if available, otherwise generates a new one.
     * Per OID4VP spec section 5.10.1: Response MUST use Content-Type: application/oauth-authz-req+jwt
     * @param sessionId
     * @param req
     * @returns
     */
    @Post("request")
    @Header("Content-Type", "application/oauth-authz-req+jwt")
    getPostRequestWithSession(@Param("sessionId") sessionId: string) {
        return this.oid4vpService.getAuthorizationRequest(sessionId);
    }

    /**
     * Endpoint to receive the response from the wallet.
     * @param body
     * @returns
     */
    @Post()
    @HttpCode(HttpStatus.OK)
    getResponse(
        @Body() body: AuthorizationResponse,
        @Param("sessionId") sessionId: string,
    ) {
        return this.oid4vpService.getResponse(body, sessionId);
    }
}
