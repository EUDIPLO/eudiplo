import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    Inject,
    Param,
    Patch,
    Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../roles/role.enum.js";
import { Secured } from "../secure.decorator.js";
import { requireTenantContext } from "../tenant-context.util.js";
import { Token, TokenPayload } from "../token.decorator.js";
import { CLIENTS_PROVIDER, ClientsProvider } from "./client.provider.js";
import { ClientResponseDto } from "./dto/client-response.dto.js";
import { ClientSecretResponseDto } from "./dto/client-secret-response.dto.js";
import { CreateClientDto } from "./dto/create-client.dto.js";
import { UpdateClientDto } from "./dto/update-client.dto.js";

/**
 * Controller to manage clients.
 */
@ApiTags("Client")
@Controller("client")
export class ClientController {
    constructor(
        @Inject(CLIENTS_PROVIDER) private readonly clients: ClientsProvider,
    ) {}

    /**
     * Get all clients for a user
     * @param user
     * @returns
     */
    @Secured([Role.Clients])
    @ApiOperation({ summary: "Get all clients for the current tenant" })
    @ApiResponse({ status: 200, type: [ClientResponseDto] })
    @Get()
    getClients(@Token() user: TokenPayload) {
        const tenantId = requireTenantContext(user);
        return this.clients.getClients(tenantId);
    }

    /**
     * Get a client by its id
     * @param id
     * @param user
     * @returns
     */
    @Secured([Role.Clients])
    @ApiOperation({ summary: "Get a client by its id" })
    @ApiResponse({ status: 200, type: ClientResponseDto })
    @ApiResponse({ status: 404, description: "Client not found" })
    @Get(":id")
    getClient(@Param("id") id: string, @Token() user: TokenPayload) {
        const tenantId = requireTenantContext(user);
        return this.clients.getClient(tenantId, id);
    }

    /**
     * Rotate (regenerate) a client's secret.
     * Returns the new secret for one-time display - save it immediately!
     *
     * Users with `tenants:manage` role can rotate secrets for any client.
     * Users with `clients:manage` role can only rotate secrets for clients in their tenant.
     *
     * @param id
     * @param user
     * @returns The new client secret (displayed only once)
     */
    @Secured([Role.Clients, Role.Tenants])
    @Post(":id/rotate-secret")
    async rotateClientSecret(
        @Param("id") id: string,
        @Token() user: TokenPayload,
    ): Promise<ClientSecretResponseDto> {
        // Tenant managers can rotate any client's secret (tenantId = null)
        // Regular client managers can only rotate their own tenant's clients
        const tenantId = user.roles.includes(Role.Tenants)
            ? null
            : requireTenantContext(user);
        const secret = await this.clients.rotateClientSecret(tenantId, id);
        return { secret };
    }

    /**
     * Update a client by its id
     * @param id
     * @param updateClientDto
     * @param user
     * @returns
     */
    @Secured([Role.Clients])
    @ApiOperation({ summary: "Update a client by its id" })
    @ApiBody({ type: UpdateClientDto })
    @ApiResponse({ status: 200, type: ClientResponseDto })
    @ApiResponse({ status: 404, description: "Client not found" })
    @Patch(":id")
    updateClient(
        @Param("id") id: string,
        @Body() updateClientDto: UpdateClientDto,
        @Token() user: TokenPayload,
    ) {
        const tenantId = requireTenantContext(user);
        // Prevent privilege escalation: only users with tenant:manage can grant tenant:manage
        if (
            (updateClientDto.roles?.includes(Role.Tenants) ||
                updateClientDto.roles?.includes(Role.TenantAdmin)) &&
            !user.roles.includes(Role.Tenants)
        ) {
            throw new ForbiddenException(
                "Cannot assign tenant:manage role without having tenant:manage privileges",
            );
        }
        return this.clients.updateClient(tenantId, id, updateClientDto);
    }

    /**
     * Create a new client
     * @param createClientDto
     * @param user
     * @returns
     */
    @Secured([Role.Clients])
    @ApiOperation({ summary: "Create a new client" })
    @ApiBody({ type: CreateClientDto })
    @ApiResponse({ status: 201, type: ClientResponseDto })
    @Post()
    createClient(
        @Body() createClientDto: CreateClientDto,
        @Token() user: TokenPayload,
    ) {
        const tenantId = requireTenantContext(user);
        // Prevent privilege escalation: only users with tenant:manage can grant tenant:manage
        if (
            (createClientDto.roles?.includes(Role.Tenants) ||
                createClientDto.roles?.includes(Role.TenantAdmin)) &&
            !user.roles.includes(Role.Tenants)
        ) {
            throw new ForbiddenException(
                "Cannot assign tenant:manage role without having tenant:manage privileges",
            );
        }
        return this.clients.addClient(tenantId, createClientDto);
    }

    /**
     * Get a client by its id
     * @param id
     * @param user
     * @returns
     */
    @Secured([Role.Clients])
    @ApiOperation({ summary: "Delete a client" })
    @ApiResponse({ status: 204, description: "Client deleted" })
    @Delete(":id")
    @HttpCode(204)
    deleteClient(@Param("id") id: string, @Token() user: TokenPayload) {
        const tenantId = requireTenantContext(user);
        return this.clients.removeClient(tenantId, id);
    }
}
