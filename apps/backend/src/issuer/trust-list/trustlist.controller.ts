import {
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Put,
} from "@nestjs/common";
import { ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../auth/token.decorator.js";
import {
    createConfigBodyPipe,
    createValidationException,
} from "../../shared/common/zod/zod-schema.util.js";
import { TrustListEntityKeyChainUsageError } from "./domain/trust-list-entity-key-chains.js";
import {
    referencesVisibleTo,
    TrustListInUseError,
    type TrustListReferenceKind,
    trustListInUseMessage,
} from "./domain/trust-list-reference.js";
import { TrustListCreateDto } from "./dto/trust-list-create.dto.js";
import { TrustListInUseDto } from "./dto/trust-list-in-use.dto.js";
import { TrustListCreateSchema } from "./schemas/trust-list.schema.js";
import { TrustListService } from "./trustlist.service.js";

/** Fields a GET response adds to the trust list (tenant, generated list). */
const readOnly = [
    "tenantId",
    "tenant",
    "keyChain",
    "data",
    "entityConfig",
    "sequenceNumber",
    "jwt",
    "createdAt",
    "updatedAt",
];

/** Roles that read each kind of configuration that can reference a trust list. */
const readRoles: Record<TrustListReferenceKind, Role[]> = {
    PresentationConfig: [Role.Presentations, Role.PresentationRequest],
    CredentialConfig: [Role.Issuances],
    IssuanceConfig: [Role.Issuances],
};

/**
 * The error a failed create or update answers with: a key chain of another
 * usage type in an internal entity as `400` with an issue at each field
 * (`entities.<index>.<field>`), any other failure as `409`.
 */
function saveError(error: Error): Error {
    if (error instanceof TrustListEntityKeyChainUsageError) {
        return createValidationException(
            error.issues.map(({ index, field, message }) => ({
                path: ["entities", index, field],
                message,
                code: "key_chain_usage_mismatch",
            })),
        );
    }
    return new ConflictException(error.message);
}

/**
 * Controller for managing trust lists.
 */
@Secured([Role.Issuances, Role.Presentations])
@ApiTags("Issuer")
@Controller("trust-list")
export class TrustListController {
    constructor(private readonly trustListService: TrustListService) {}

    /**
     * Creates a new trust list for the tenant
     * @param body
     * @returns
     */
    @Post()
    @ApiResponse({
        status: 400,
        description:
            "The body fails validation, or an internal entity names a key chain whose usage type cannot provide its certificate: issuerKeyChainId needs attestation, revocationKeyChainId statusList or attestation. errors[].path names the field",
    })
    @ApiResponse({
        status: 409,
        description:
            "The trust list cannot be created, for example because a key chain does not exist or keyChainId names no trustList key chain",
    })
    createTrustList(
        @Body(createConfigBodyPipe(TrustListCreateSchema, { readOnly }))
        body: TrustListCreateDto,
        @Token() token: TokenPayload,
    ) {
        return this.trustListService
            .create(body, token.entity!)
            .catch((err) => {
                throw saveError(err);
            });
    }

    /**
     * Returns all trust lists for the tenant
     * @param token
     * @returns
     */
    @Get()
    getAllTrustLists(@Token() token: TokenPayload) {
        return this.trustListService.findAll(token.entity!);
    }

    /**
     * Returns the trust list by id for the tenant
     * @param tenantId
     * @param id
     * @returns
     */
    @Get(":id")
    getTrustList(@Token() token: TokenPayload, @Param("id") id: string) {
        return this.trustListService.findOne(token.entity!.id, id).catch(() => {
            throw new ConflictException("Trust list not found");
        });
    }

    /**
     * Exports the trust list in the format accepted by create and config import
     * @param token
     * @param id
     * @returns
     */
    @Get(":id/export")
    exportTrustList(@Token() token: TokenPayload, @Param("id") id: string) {
        return this.trustListService
            .exportTrustList(token.entity!.id, id)
            .catch(() => {
                throw new ConflictException("Trust list not found");
            });
    }

    /**
     * Returns the version history for a trust list
     * @param token
     * @param id
     * @returns
     */
    @Get(":id/versions")
    getTrustListVersions(
        @Token() token: TokenPayload,
        @Param("id") id: string,
    ) {
        return this.trustListService
            .getVersionHistory(token.entity!.id, id)
            .catch(() => {
                throw new ConflictException("Trust list not found");
            });
    }

    /**
     * Returns a specific version of a trust list
     * @param token
     * @param id
     * @param versionId
     * @returns
     */
    @Get(":id/versions/:versionId")
    getTrustListVersion(
        @Token() token: TokenPayload,
        @Param("id") id: string,
        @Param("versionId") versionId: string,
    ) {
        return this.trustListService
            .getVersion(token.entity!.id, id, versionId)
            .catch(() => {
                throw new ConflictException("Trust list version not found");
            });
    }

    /**
     * Updates a trust list with new entities
     * Creates a new version for audit and regenerates the JWT
     * @param id
     * @param body
     * @param token
     * @returns
     */
    @Put(":id")
    @ApiResponse({
        status: 400,
        description:
            "The body fails validation, or an internal entity names a key chain whose usage type cannot provide its certificate: issuerKeyChainId needs attestation, revocationKeyChainId statusList or attestation. errors[].path names the field; a key chain the stored list already names in that field is accepted",
    })
    @ApiResponse({
        status: 409,
        description:
            "The trust list cannot be updated, for example because it or a key chain does not exist, keyChainId names no trustList key chain, or another update or a renewal was published since it was read",
    })
    updateTrustList(
        @Param("id") id: string,
        @Body(createConfigBodyPipe(TrustListCreateSchema, { readOnly }))
        body: TrustListCreateDto,
        @Token() token: TokenPayload,
    ) {
        return this.trustListService
            .update(token.entity!.id, id, body)
            .catch((err) => {
                throw saveError(err);
            });
    }

    /**
     * Deletes a trust list that no configuration of the tenant references
     * @param id
     * @param token
     * @returns
     */
    @Delete(":id")
    @ApiResponse({ status: 204, description: "Trust list deleted" })
    @ApiResponse({
        status: 409,
        type: TrustListInUseDto,
        description:
            "Presentation configs, credential configs or the issuance configuration of the tenant still reference the trust list; the response names those the caller may read and counts the others",
    })
    @HttpCode(204)
    async deleteTrustList(
        @Param("id") id: string,
        @Token() token: TokenPayload,
    ): Promise<void> {
        try {
            await this.trustListService.removeUnreferenced(
                token.entity!.id,
                id,
            );
        } catch (error) {
            if (error instanceof TrustListInUseError) {
                // Configurations the caller may not read are only counted.
                const references = referencesVisibleTo(
                    error.references,
                    (kind) =>
                        readRoles[kind].some((role) =>
                            token.roles?.includes(role),
                        ),
                );
                throw new ConflictException({
                    code: "TRUST_LIST_IN_USE",
                    message: trustListInUseMessage(
                        id,
                        references,
                        (kind) => readRoles[kind],
                    ),
                    references,
                });
            }
            throw error;
        }
    }
}
