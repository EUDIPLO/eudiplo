import { Inject, Injectable } from "@nestjs/common";
import { Role } from "../roles/role.enum.js";
import {
    assertMayChangeRoles,
    assertMayManageRoles,
} from "../roles/role-grants.js";
import { CLIENTS_PROVIDER, ClientsProvider } from "./client.provider.js";

/**
 * Whether the caller rotates the secret of a client of any tenant, rather
 * than only of its own. The controller and ConfigGenerationInterceptor, which
 * checks the file-managed state of the client's tenant, both decide by it.
 */
export function rotatesSecretsOfAnyTenant(
    callerRoles: readonly string[] | undefined,
): boolean {
    return callerRoles?.includes(Role.Tenants) ?? false;
}

/**
 * The authorization check for acting on an existing client, shared by the
 * client API and configuration bundle imports.
 */
@Injectable()
export class ClientAccessService {
    constructor(
        @Inject(CLIENTS_PROVIDER) private readonly clients: ClientsProvider,
    ) {}

    /**
     * Refuses to change, delete or rotate the secret of a client of the tenant
     * that has a role the caller neither holds nor may grant.
     * @returns The client's roles, or `undefined` when the tenant has no such client
     */
    async assertMayManage(
        callerRoles: readonly string[],
        tenantId: string,
        clientId: string,
    ): Promise<string[] | undefined> {
        const roles = await this.clients.getClientRoles(tenantId, clientId);
        if (roles) {
            assertMayManageRoles(callerRoles, roles, `client ${clientId}`);
        }
        return roles;
    }

    /**
     * Refuses to give a new or existing client of the tenant `roles` the
     * caller may not grant; roles the client already has may stay.
     */
    async assertMayAssignRoles(
        callerRoles: readonly string[],
        tenantId: string,
        clientId: string,
        roles: readonly string[],
    ): Promise<void> {
        const current =
            (await this.clients.getClientRoles(tenantId, clientId)) ?? [];
        assertMayChangeRoles(callerRoles, current, roles);
    }
}
