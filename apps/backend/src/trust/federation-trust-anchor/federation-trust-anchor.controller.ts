import {
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    NotFoundException,
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
import { ConflictError } from "../../shared/domain/conflict-error.js";
import { FederationTrustAnchorNotFound } from "./domain/federation-trust-anchor-errors.js";
import {
    FederationTrustAnchorInUseError,
    type FederationTrustAnchorReferenceKind,
    federationTrustAnchorInUseMessage,
    federationTrustAnchorReferencesVisibleTo,
} from "./domain/federation-trust-anchor-reference.js";
import {
    CreateFederationTrustAnchorDto,
    UpdateFederationTrustAnchorDto,
} from "./dto/federation-trust-anchor.dto.js";
import { FederationTrustAnchorInUseDto } from "./dto/federation-trust-anchor-in-use.dto.js";
import { FederationTrustAnchorResponseDto } from "./dto/federation-trust-anchor-response.dto.js";
import { FederationTrustAnchorService } from "./federation-trust-anchor.service.js";

/** Roles that read each kind of configuration that can name a trust anchor. */
const readRoles: Record<FederationTrustAnchorReferenceKind, Role[]> = {
    PresentationConfig: [Role.Presentations, Role.PresentationRequest],
    IssuanceConfig: [Role.Issuances],
};

/**
 * Maps the service's errors to their HTTP status. Configurations naming an
 * anchor in use that the caller may not read are only counted.
 */
function httpError(error: unknown, token: TokenPayload): never {
    if (error instanceof FederationTrustAnchorInUseError) {
        const references = federationTrustAnchorReferencesVisibleTo(
            error.references,
            (kind) =>
                readRoles[kind].some((role) => token.roles?.includes(role)),
        );
        throw new ConflictException({
            code: "FEDERATION_TRUST_ANCHOR_IN_USE",
            message: federationTrustAnchorInUseMessage(
                error.anchorId,
                error.entityId,
                error.change,
                references,
                (kind) => readRoles[kind],
            ),
            references,
        });
    }
    if (error instanceof FederationTrustAnchorNotFound) {
        throw new NotFoundException(error.message);
    }
    // A taken ID (ResourceIdTaken) or entity ID (FederationTrustAnchorConflict).
    if (error instanceof ConflictError) {
        throw new ConflictException(error.message);
    }
    throw error;
}

/**
 * OpenID Federation trust anchors with pinned keys. Issuance configurations
 * (`federation.trustAnchors`) and presentation configurations (DCQL
 * `openid_federation`) name them by entity ID, so both roles manage them.
 */
@ApiTags("Trust")
@Secured([Role.Issuances, Role.Presentations])
@Controller("federation-trust-anchor")
export class FederationTrustAnchorController {
    constructor(private readonly service: FederationTrustAnchorService) {}

    @Get()
    @ApiOperation({ summary: "List the tenant's federation trust anchors" })
    @ApiResponse({
        status: 200,
        description: "List of federation trust anchors",
        type: [FederationTrustAnchorResponseDto],
    })
    getAll(@Token() user: TokenPayload) {
        return this.service.getAll(user.entity!.id);
    }

    @Get(":id")
    @ApiOperation({ summary: "Get a federation trust anchor by ID" })
    @ApiResponse({
        status: 200,
        description: "The federation trust anchor",
        type: FederationTrustAnchorResponseDto,
    })
    @ApiResponse({ status: 404, description: "Trust anchor not found" })
    getById(@Param("id") id: string, @Token() user: TokenPayload) {
        return this.service
            .getById(user.entity!.id, id)
            .catch((error) => httpError(error, user));
    }

    @Post()
    @ApiOperation({ summary: "Register a federation trust anchor" })
    @ApiResponse({
        status: 201,
        description: "Trust anchor registered",
        type: FederationTrustAnchorResponseDto,
    })
    @ApiResponse({
        status: 409,
        description: "The ID or entity ID is already registered",
    })
    @ApiBody({ type: CreateFederationTrustAnchorDto })
    create(
        @Body() dto: CreateFederationTrustAnchorDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.service
            .create(user.entity!.id, dto, user, requestMeta)
            .catch((error) => httpError(error, user));
    }

    @Patch(":id")
    @ApiOperation({ summary: "Update a federation trust anchor" })
    @ApiResponse({
        status: 200,
        description: "Trust anchor updated",
        type: FederationTrustAnchorResponseDto,
    })
    @ApiResponse({ status: 404, description: "Trust anchor not found" })
    @ApiResponse({
        status: 409,
        description:
            "The entity ID is already registered (body with `message` only), or the update changes the entity ID while presentation configs or the issuance configuration of the tenant still name the old one (body as for DELETE, with code FEDERATION_TRUST_ANCHOR_IN_USE and `references`)",
    })
    @ApiBody({ type: UpdateFederationTrustAnchorDto })
    update(
        @Param("id") id: string,
        @Body() dto: UpdateFederationTrustAnchorDto,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.service
            .update(user.entity!.id, id, dto, user, requestMeta)
            .catch((error) => httpError(error, user));
    }

    @Delete(":id")
    @ApiOperation({ summary: "Delete a federation trust anchor" })
    @ApiResponse({ status: 204, description: "Trust anchor deleted" })
    @ApiResponse({ status: 404, description: "Trust anchor not found" })
    @ApiResponse({
        status: 409,
        type: FederationTrustAnchorInUseDto,
        description:
            "Presentation configs or the issuance configuration of the tenant still name the trust anchor's entity ID; the response names those the caller may read and counts the others",
    })
    @HttpCode(204)
    delete(
        @Param("id") id: string,
        @Token() user: TokenPayload,
        @AuditMeta() requestMeta: AuditLogRequestMeta,
    ) {
        return this.service
            .delete(user.entity!.id, id, user, requestMeta)
            .catch((error) => httpError(error, user));
    }
}
