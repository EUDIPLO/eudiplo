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
import { TrustListInputError } from "./domain/trust-list-input.js";
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
 * Answers refused fields of a create or update with `400` and an issue at each
 * (`errors[].path`). Other failures pass on: an unknown trust list as `404`, a
 * concurrent update and a missing signing key chain as `409`, anything else
 * as `500`.
 */
function saveError(error: unknown): never {
    if (error instanceof TrustListInputError) {
        throw createValidationException(error.issues);
    }
    throw error;
}

const BAD_REQUEST =
    "The body fails validation, or a field names a key chain that does not exist or has the wrong usage type, or holds a value a trust list cannot publish: keyChainId needs a trustList key chain, issuerKeyChainId an attestation one and revocationKeyChainId a statusList or attestation one; issuerCertPem and revocationCertPem need an X.509 certificate, info.country an ISO 3166-1 alpha-2 code in capital letters (UK, EL, EU as exceptions), info.lang a lower-case RFC 5646 language tag and info.uri an absolute URI in serialized form (ETSI TS 119 602). errors[].path names each field";
const LIST_NOT_FOUND = "The tenant has no trust list with this ID";

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
    @ApiResponse({ status: 400, description: BAD_REQUEST })
    @ApiResponse({
        status: 409,
        description:
            "The body sets no keyChainId, and the tenant has no trustList key chain or the one EUDIPLO picks has no valid certificate",
    })
    createTrustList(
        @Body(createConfigBodyPipe(TrustListCreateSchema, { readOnly }))
        body: TrustListCreateDto,
        @Token() token: TokenPayload,
    ) {
        return this.trustListService
            .create(body, token.entity!)
            .catch(saveError);
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
    @ApiResponse({ status: 404, description: LIST_NOT_FOUND })
    getTrustList(@Token() token: TokenPayload, @Param("id") id: string) {
        return this.trustListService.get(token.entity!.id, id);
    }

    /**
     * Exports the trust list in the format accepted by create and config import
     * @param token
     * @param id
     * @returns
     */
    @Get(":id/export")
    @ApiResponse({ status: 404, description: LIST_NOT_FOUND })
    exportTrustList(@Token() token: TokenPayload, @Param("id") id: string) {
        return this.trustListService.exportTrustList(token.entity!.id, id);
    }

    /**
     * Returns the version history for a trust list
     * @param token
     * @param id
     * @returns
     */
    @Get(":id/versions")
    @ApiResponse({ status: 404, description: LIST_NOT_FOUND })
    getTrustListVersions(
        @Token() token: TokenPayload,
        @Param("id") id: string,
    ) {
        return this.trustListService.getVersionHistory(token.entity!.id, id);
    }

    /**
     * Returns a specific version of a trust list
     * @param token
     * @param id
     * @param versionId
     * @returns
     */
    @Get(":id/versions/:versionId")
    @ApiResponse({
        status: 404,
        description:
            "The tenant has no trust list with this ID or it has no such version",
    })
    getTrustListVersion(
        @Token() token: TokenPayload,
        @Param("id") id: string,
        @Param("versionId") versionId: string,
    ) {
        return this.trustListService.getVersion(
            token.entity!.id,
            id,
            versionId,
        );
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
        description: `${BAD_REQUEST}. An entity key chain of another usage type that the stored list already names in the same field is accepted`,
    })
    @ApiResponse({ status: 404, description: LIST_NOT_FOUND })
    @ApiResponse({
        status: 409,
        description:
            "Another update or a renewal was published since the list was read, so read it again and retry; or the body sets no keyChainId and the key chain the list is signed with no longer has usage type trustList, so name a trustList key chain in keyChainId",
    })
    updateTrustList(
        @Param("id") id: string,
        @Body(createConfigBodyPipe(TrustListCreateSchema, { readOnly }))
        body: TrustListCreateDto,
        @Token() token: TokenPayload,
    ) {
        return this.trustListService
            .update(token.entity!.id, id, body)
            .catch(saveError);
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
