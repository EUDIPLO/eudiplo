import { Controller, Get, Header, Param, Res } from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { ContentType } from "../../../../shared/utils/media-type/media-type.decorator.js";
import { MediaType } from "../../../../shared/utils/media-type/media-type.enum.js";
import { JwksResponseDto } from "./dto/jwks-response.dto.js";
import { WellKnownService } from "./well-known.service.js";

/**
 * Controller for the OpenID4VCI well-known endpoints.
 */
@ApiTags("OID4VCI")
@Controller()
export class WellKnownController {
    /**
     * Constructor for WellKnownController.
     * @param wellKnownService
     */
    constructor(private readonly wellKnownService: WellKnownService) {}

    /**
     * Retrieves the OpenID4VCI issuer metadata for a given tenant.
     * @param tenantId
     * @param contentType
     * @returns
     */
    @ApiOperation({
        summary: "Get OpenID4VCI issuer metadata",
        description: "Returns the OpenID4VCI issuer metadata.",
    })
    //we can not set the accept in the apiheader via swagger.
    @ApiProduces(MediaType.APPLICATION_JSON, MediaType.APPLICATION_JWT)
    @Get(".well-known/openid-credential-issuer/issuers/:tenantId")
    async issuerMetadata(
        @Res({ passthrough: true }) res: Response,
        @ContentType() contentType: MediaType,
        @Param("tenantId") tenantId: string,
    ) {
        const result = await this.wellKnownService.getIssuerMetadata(
            tenantId,
            contentType,
        );

        // Set Content-Type header based on requested media type
        if (contentType === MediaType.APPLICATION_JWT) {
            res.setHeader("Content-Type", MediaType.APPLICATION_JWT);
        }

        return result;
    }

    /**
     * Authorization Server Metadata
     * @returns
     */
    @Get(".well-known/oauth-authorization-server/issuers/:tenantId")
    authzMetadata(@Param("tenantId") tenantId: string) {
        return this.wellKnownService.getAuthzMetadata(tenantId);
    }

    /**
     * Chained Authorization Server Metadata (RFC 8414 alternative path format).
     * Supports discovery via `/.well-known/oauth-authorization-server/:tenantId/chained-as`
     * for wallets that construct the discovery URL per RFC 8414.
     * @returns
     */
    @Get(".well-known/oauth-authorization-server/issuers/:tenantId/chained-as")
    chainedAsMetadata(@Param("tenantId") tenantId: string) {
        return this.wellKnownService.getChainedAsMetadata(tenantId);
    }

    /**
     * Returns the JSON Web Key Set (JWKS) for the authorization server.
     * @returns
     */
    @Header("Content-Type", "application/jwk-set+json")
    @Get(".well-known/jwks.json/issuers/:tenantId")
    getJwks(@Param("tenantId") tenantId: string): Promise<JwksResponseDto> {
        return this.wellKnownService.getJwks(tenantId);
    }

    /**
     * Returns the JSON Web Key Set (JWKS) for the Chained Authorization Server.
     * @returns
     */
    @Header("Content-Type", "application/jwk-set+json")
    @Get(".well-known/jwks.json/issuers/:tenantId/chained-as")
    getChainedAsJwks(
        @Param("tenantId") tenantId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        return this.wellKnownService.getChainedAsJwks(tenantId);
    }

    @Get(
        ".well-known/oauth-authorization-server/issuers/:tenantId/authorization-servers/:authorizationServerId",
    )
    managedAuthorizationServerMetadata(
        @Param("tenantId") tenantId: string,
        @Param("authorizationServerId") authorizationServerId: string,
    ) {
        return this.wellKnownService.getManagedAuthorizationServerMetadata(
            tenantId,
            authorizationServerId,
        );
    }

    @Header("Content-Type", "application/jwk-set+json")
    @Get(
        ".well-known/jwks.json/issuers/:tenantId/authorization-servers/:authorizationServerId",
    )
    managedAuthorizationServerJwks(
        @Param("tenantId") tenantId: string,
        @Param("authorizationServerId") authorizationServerId: string,
    ): Promise<{ keys: Record<string, unknown>[] }> {
        return this.wellKnownService.getManagedAuthorizationServerJwks(
            tenantId,
            authorizationServerId,
        );
    }
}
