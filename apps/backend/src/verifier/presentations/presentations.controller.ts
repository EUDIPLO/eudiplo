import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { AuditLogRequestMeta } from "../../audit-log/audit-log.service.js";
import { AuditMeta } from "../../audit-log/audit-log-context.util.js";
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../auth/token.decorator.js";
import { CredentialIssuerMetadataDto } from "../../issuer/issuance/oid4vci/well-known/dto/credential-issuer-metadata.dto.js";
import { SchemaMetadataResponseDto } from "../../registrar/schema-metadata/dto/schema-metadata.dto.js";
import { PresentationConfigCreateDto } from "./dto/presentation-config-create.dto.js";
import { PresentationConfigUpdateDto } from "./dto/presentation-config-update.dto.js";
import { ResolveIssuerMetadataDto } from "./dto/resolve-issuer-metadata.dto.js";
import { ResolveSchemaMetadataDto } from "./dto/resolve-schema-metadata.dto.js";
import { ResolveSchemaMetadataJwtDto } from "./dto/resolve-schema-metadata-jwt.dto.js";
import { ResolvedSchemaMetadataResponseDto } from "./dto/resolved-schema-metadata-response.dto.js";
import { PresentationConfig } from "./entities/presentation-config.entity.js";
import { PresentationsService } from "./presentations.service.js";

@ApiTags("Verifier")
@Controller("verifier/config")
export class PresentationManagementController {
    constructor(private readonly presentationsService: PresentationsService) {}

    /**
     * Returns the presentation request configurations.
     * @returns
     */
    @Secured([Role.Presentations, Role.PresentationRequest])
    @Get()
    configuration(@Token() user: TokenPayload) {
        return this.presentationsService.getPresentationConfigs(
            user.entity!.id,
        );
    }

    /**
     * Resolve external OID4VCI issuer metadata server-side.
     * This avoids browser CORS limitations when browsing issuer metadata.
     */
    @Secured([Role.Presentations, Role.PresentationRequest])
    @Post("issuer-metadata/resolve")
    @ApiOperation({
        summary: "Resolve external issuer metadata",
        description:
            "Fetches OpenID4VCI credential issuer metadata from an external issuer URL on the server side.",
    })
    @ApiBody({ type: ResolveIssuerMetadataDto })
    @ApiResponse({
        status: 200,
        description: "Resolved credential issuer metadata",
        type: CredentialIssuerMetadataDto,
    })
    @ApiResponse({
        status: 400,
        description: "Invalid issuer URL or metadata could not be resolved",
    })
    async resolveIssuerMetadata(@Body() body: ResolveIssuerMetadataDto) {
        return this.presentationsService.resolveCredentialIssuerMetadata(
            body.issuerUrl,
        );
    }

    /**
     * Resolve schema metadata server-side and decode its signed JWT payload.
     * This avoids browser CORS limitations when importing schema metadata
     * directly from registrar URLs.
     */
    @Secured([Role.Presentations, Role.PresentationRequest])
    @Post("schema-metadata/resolve")
    @ApiOperation({
        summary: "Resolve external schema metadata",
        description:
            "Fetches schema metadata from an external URL, extracts signedJwt, validates the JWT payload shape and returns normalized fields for presentation config import.",
    })
    @ApiBody({ type: ResolveSchemaMetadataDto })
    @ApiResponse({
        status: 200,
        description: "Resolved schema metadata import payload",
        type: ResolvedSchemaMetadataResponseDto,
    })
    @ApiResponse({
        status: 400,
        description:
            "Invalid URL, invalid response, or invalid schema metadata JWT",
    })
    async resolveSchemaMetadata(@Body() body: ResolveSchemaMetadataDto) {
        return this.presentationsService.resolveSchemaMetadata(
            body.schemaMetadataUrl,
        );
    }

    /**
     * Resolve schema metadata JWT directly.
     * This endpoint accepts a signed JWT and resolves it into DCQL and references
     * without requiring a URL fetch. Useful for resolving catalog entries.
     */
    @Secured([Role.Presentations, Role.PresentationRequest])
    @Post("schema-metadata/resolve-jwt")
    @ApiOperation({
        summary: "Resolve schema metadata JWT",
        description:
            "Validates and resolves a signed schema metadata JWT directly, building DCQL and resolving schema references. Useful for resolving catalog entries without requiring external URL accessibility.",
    })
    @ApiBody({ type: ResolveSchemaMetadataJwtDto })
    @ApiResponse({
        status: 200,
        description: "Resolved schema metadata import payload",
        type: ResolvedSchemaMetadataResponseDto,
    })
    @ApiResponse({
        status: 400,
        description: "Invalid JWT or invalid schema metadata",
    })
    async resolveSchemaMetadataJwt(@Body() body: ResolveSchemaMetadataJwtDto) {
        return this.presentationsService.resolveSchemaMetadataJwt(
            body.signedJwt,
        );
    }

    /**
     * List schema metadata entries from the connected registrar catalog.
     * Returns an empty array when the registrar is not enabled for this tenant.
     */
    @Secured([Role.Presentations, Role.PresentationRequest])
    @Get("schema-metadata/catalog")
    @ApiOperation({
        summary: "List schema metadata from the registrar catalog",
        description:
            "Returns all schema metadata entries from the configured registrar. Returns an empty array when no registrar is configured.",
    })
    @ApiResponse({
        status: 200,
        description: "Catalog entries from the registrar",
        type: [SchemaMetadataResponseDto],
    })
    listSchemaMetadataCatalog(@Token() user: TokenPayload) {
        return this.presentationsService.listSchemaMetadataCatalog(
            user.entity!.id,
        );
    }

    /**
     * Store a presentation request configuration. If it already exists, it will be updated.
     * @param config
     * @returns
     */
    @Secured([Role.Presentations])
    @Post()
    @ApiResponse({ status: 201, type: PresentationConfig })
    storePresentationConfig(
        @Body() config: PresentationConfigCreateDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.presentationsService.storePresentationConfig(
            user.entity!.id,
            config,
            user,
            requestMeta,
        );
    }

    /**
     * Get a presentation request configuration by its ID.
     * @param id
     * @param user
     * @returns
     */
    @Secured([Role.Presentations, Role.PresentationRequest])
    @Get(":id")
    @ApiResponse({ status: 200, type: PresentationConfig })
    getConfiguration(@Param("id") id: string, @Token() user: TokenPayload) {
        return this.presentationsService.getPresentationConfig(
            id,
            user.entity!.id,
        );
    }

    /**
     * Update a presentation request configuration by its ID.
     * @param id
     * @param config
     * @param user
     * @returns
     */
    @Secured([Role.Presentations])
    @Patch(":id")
    @ApiResponse({ status: 200, type: PresentationConfig })
    updateConfiguration(
        @Param("id") id: string,
        @Body() config: PresentationConfigUpdateDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.presentationsService.updatePresentationConfig(
            id,
            user.entity!.id,
            config,
            user,
            requestMeta,
        );
    }

    /**
     * Deletes a presentation request configuration by its ID.
     * @param id
     * @returns
     */
    @Secured([Role.Presentations])
    @Delete(":id")
    @ApiResponse({
        status: 204,
        description: "Presentation configuration deleted",
    })
    @HttpCode(204)
    deleteConfiguration(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.presentationsService.deletePresentationConfig(
            id,
            user.entity!.id,
            user,
            requestMeta,
        );
    }

    /**
     * Force-reissue the registration certificate for a presentation
     * configuration. Bypasses and refreshes the embedded cache.
     */
    @Secured([Role.Presentations])
    @Post(":id/registration-cert/reissue")
    @ApiOperation({
        summary: "Reissue the registration certificate cache",
        description:
            "Bypasses the embedded registration-certificate cache and re-resolves it from the configured registrar.",
    })
    @ApiResponse({
        status: 200,
        description: "Updated presentation configuration",
        type: PresentationConfig,
    })
    @ApiResponse({
        status: 400,
        description:
            "Config has no registrationCert spec or registrar is not enabled",
    })
    reissueRegistrationCertificate(
        @Param("id") id: string,
        @Token() user: TokenPayload,
    ) {
        return this.presentationsService.reissueRegistrationCertificate(
            id,
            user.entity!.id,
        );
    }
}
