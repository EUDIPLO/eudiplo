import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    ApiConflictResponse,
    ApiCreatedResponse,
    ApiNoContentResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from "@nestjs/swagger";
import { Role } from "../../auth/roles/role.enum.js";
import { Secured } from "../../auth/secure.decorator.js";
import { Token, TokenPayload } from "../../auth/token.decorator.js";
import { CreateStatusListDto } from "./dto/create-status-list.dto.js";
import { StatusListResponseDto } from "./dto/status-list-response.dto.js";
import { UpdateStatusListDto } from "./dto/update-status-list.dto.js";
import { StatusListEntity } from "./entities/status-list.entity.js";
import { StatusListService } from "./status-list.service.js";

/**
 * Controller for managing status lists.
 * Allows creating, listing, updating, and deleting status lists.
 */
@ApiTags("status-lists")
@Controller("status-lists")
@Secured([Role.Issuances])
export class StatusListManagementController {
    constructor(
        private readonly statusListService: StatusListService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Convert a StatusListEntity to a response DTO.
     */
    private toResponseDto(entity: StatusListEntity): StatusListResponseDto {
        const baseUrl = this.configService.getOrThrow<string>("PUBLIC_URL");
        return {
            id: entity.id,
            tenantId: entity.tenantId,
            credentialConfigurationId: entity.credentialConfigurationId,
            keyChainId: entity.keyChainId,
            bits: entity.bits,
            capacity: entity.elements.length,
            usedEntries: entity.elements.length - entity.stack.length,
            availableEntries: entity.stack.length,
            uri: `${baseUrl}/issuers/${entity.tenantId}/status-management/status-list/${entity.id}`,
            createdAt: entity.createdAt,
            expiresAt: entity.expiresAt,
        };
    }

    /**
     * Get all status lists for the tenant.
     */
    @Get()
    @ApiOperation({
        summary: "List all status lists",
        description:
            "Returns all status lists for the tenant, including their capacity and usage.",
    })
    @ApiOkResponse({
        description: "List of status lists",
        type: [StatusListResponseDto],
    })
    async getLists(
        @Token() token: TokenPayload,
    ): Promise<StatusListResponseDto[]> {
        const lists = await this.statusListService.getLists(token.entity!.id);
        return lists.map((list) => this.toResponseDto(list));
    }

    /**
     * Get a specific status list by ID.
     */
    @Get(":listId")
    @ApiOperation({
        summary: "Get a status list",
        description: "Returns details for a specific status list.",
    })
    @ApiParam({
        name: "listId",
        description: "The status list ID",
    })
    @ApiOkResponse({
        description: "The status list",
        type: StatusListResponseDto,
    })
    async getList(
        @Token() token: TokenPayload,
        @Param("listId") listId: string,
    ): Promise<StatusListResponseDto> {
        const list = await this.statusListService.getListById(
            token.entity!.id,
            listId,
        );
        return this.toResponseDto(list);
    }

    /**
     * Create a new status list.
     */
    @Post()
    @ApiOperation({
        summary: "Create a status list",
        description:
            "Creates a new status list. Optionally bind it to a specific credential configuration and/or certificate.",
    })
    @ApiCreatedResponse({
        description: "The created status list",
        type: StatusListResponseDto,
    })
    async createList(
        @Token() token: TokenPayload,
        @Body() dto: CreateStatusListDto,
    ): Promise<StatusListResponseDto> {
        const list = await this.statusListService.createNewList(
            token.entity!.id,
            {
                credentialConfigurationId: dto.credentialConfigurationId,
                keyChainId: dto.keyChainId,
                bits: dto.bits,
                capacity: dto.capacity,
            },
        );
        return this.toResponseDto(list);
    }

    /**
     * Update a status list's configuration.
     */
    @Patch(":listId")
    @ApiOperation({
        summary: "Update a status list",
        description:
            "Update a status list's credential configuration binding and/or certificate.",
    })
    @ApiParam({
        name: "listId",
        description: "The status list ID",
    })
    @ApiOkResponse({
        description: "The updated status list",
        type: StatusListResponseDto,
    })
    async updateList(
        @Token() token: TokenPayload,
        @Param("listId") listId: string,
        @Body() dto: UpdateStatusListDto,
    ): Promise<StatusListResponseDto> {
        const list = await this.statusListService.updateList(
            token.entity!.id,
            listId,
            {
                credentialConfigurationId: dto.credentialConfigurationId,
                keyChainId: dto.keyChainId,
            },
        );
        return this.toResponseDto(list);
    }

    /**
     * Delete a status list.
     * Only allowed if no credentials are using it.
     */
    @Delete(":listId")
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: "Delete a status list",
        description:
            "Delete a status list. Only allowed if no credentials are using it.",
    })
    @ApiParam({
        name: "listId",
        description: "The status list ID",
    })
    @ApiNoContentResponse({
        description: "Status list deleted successfully",
    })
    @ApiNotFoundResponse({ description: "Status list not found" })
    @ApiConflictResponse({
        description:
            "Credentials issued with the status list still use it; the message gives their number",
    })
    async deleteList(
        @Token() token: TokenPayload,
        @Param("listId") listId: string,
    ): Promise<void> {
        await this.statusListService.deleteList(token.entity!.id, listId);
    }
}
