import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    NotFoundException,
    Param,
    Patch,
    Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../roles/role.enum.js";
import {
    assertMayChangeRoles,
    assertMayGrantRoles,
    GRANT_DENIED_DESCRIPTION,
    manageDeniedDescription,
} from "../roles/role-grants.js";
import { Secured } from "../secure.decorator.js";
import { requireTenantContext } from "../tenant-context.util.js";
import { Token, TokenPayload } from "../token.decorator.js";
import { CLIENTS_PROVIDER, ClientsProvider } from "./client.provider.js";
import { ClientAccessService } from "./client-access.service.js";
import { ClientIdTaken } from "./domain/client-data.js";
import { ClientResponseDto } from "./dto/client-response.dto.js";
import { ClientSecretResponseDto } from "./dto/client-secret-response.dto.js";
import { CreateClientDto } from "./dto/create-client.dto.js";
import { UpdateClientDto } from "./dto/update-client.dto.js";

const MANAGE_DENIED = manageDeniedDescription("client");

/**
 * Controller to manage clients.
 */
@ApiTags("Client")
@ApiResponse({
    status: 501,
    description:
        "With `OIDC_PROVIDER=generic`, the identity provider manages the clients",
})
@Controller("client")
export class ClientController {
    constructor(
        @Inject(CLIENTS_PROVIDER) private readonly clients: ClientsProvider,
        private readonly access: ClientAccessService,
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
     * Users with `clients:manage` role can only rotate secrets for clients in
     * their tenant whose roles they hold or may grant.
     *
     * With the built-in authorization server, tokens issued with the old secret
     * are rejected at once (HTTP 401).
     *
     * @param id
     * @param user
     * @returns The new client secret (displayed only once)
     */
    @Secured([Role.Clients, Role.Tenants])
    @ApiResponse({ status: 403, description: MANAGE_DENIED })
    @ApiResponse({ status: 404, description: "Client not found" })
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
        if (tenantId) {
            await this.assertMayManageExisting(user, tenantId, id);
        }
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
    @ApiResponse({
        status: 403,
        description: `${GRANT_DENIED_DESCRIPTION}. ${MANAGE_DENIED}`,
    })
    @ApiResponse({ status: 404, description: "Client not found" })
    @Patch(":id")
    async updateClient(
        @Param("id") id: string,
        @Body() updateClientDto: UpdateClientDto,
        @Token() user: TokenPayload,
    ) {
        const tenantId = requireTenantContext(user);
        const roles = await this.assertMayManageExisting(user, tenantId, id);
        if (updateClientDto.roles) {
            assertMayChangeRoles(user.roles, roles, updateClientDto.roles);
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
    @ApiResponse({ status: 403, description: GRANT_DENIED_DESCRIPTION })
    @ApiResponse({
        status: 409,
        description: "The client ID is already in use",
    })
    @Post()
    async createClient(
        @Body() createClientDto: CreateClientDto,
        @Token() user: TokenPayload,
    ) {
        const tenantId = requireTenantContext(user);
        assertMayGrantRoles(user.roles, createClientDto.roles);
        // Creating must never replace a client, not even one of this tenant.
        if (await this.clients.getClientById(createClientDto.clientId)) {
            throw new ClientIdTaken(createClientDto.clientId);
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
    @ApiResponse({
        status: 204,
        description: "Client deleted, or the tenant has no such client",
    })
    @ApiResponse({ status: 403, description: MANAGE_DENIED })
    @Delete(":id")
    @HttpCode(204)
    async deleteClient(@Param("id") id: string, @Token() user: TokenPayload) {
        const tenantId = requireTenantContext(user);
        const roles = await this.access.assertMayManage(
            user.roles,
            tenantId,
            id,
        );
        // Deleting an unknown client stays a no-op; it must not reach a
        // Keycloak client outside the tenant's mirror.
        if (!roles) return;
        return this.clients.removeClient(tenantId, id);
    }

    /**
     * Refuses to act on a client the tenant does not have, or that has a role
     * the caller neither holds nor may grant.
     * @returns The client's current roles
     */
    private async assertMayManageExisting(
        user: TokenPayload,
        tenantId: string,
        clientId: string,
    ): Promise<string[]> {
        const roles = await this.access.assertMayManage(
            user.roles,
            tenantId,
            clientId,
        );
        if (!roles) {
            throw new NotFoundException(`Client '${clientId}' not found`);
        }
        return roles;
    }
}
