import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ClientsProvider } from "../client.provider.js";
import {
    type ClientData,
    ClientsManagedByIdentityProvider,
    type CreatedClient,
} from "../domain/client-data.js";
import { ClientEntity } from "../entities/client.entity.js";
import type { CreateClient, UpdateClient } from "../schemas/client.schema.js";

/**
 * Clients with `OIDC_PROVIDER=generic`: the identity provider manages them,
 * and EUDIPLO creates no client records. Records left from an earlier mode
 * are read, so a client created with Keycloak keeps its resource limits and
 * its tenant; other tokens get no limits. Every other call fails, which the
 * HTTP boundary answers with `501`.
 */
@Injectable()
export class IdpManagedClientsProvider extends ClientsProvider {
    constructor(
        @InjectRepository(ClientEntity)
        private readonly clientRepo: Repository<ClientEntity>,
    ) {
        super();
    }

    private unsupported(): never {
        throw new ClientsManagedByIdentityProvider();
    }

    assertCanCreateClients(): void {
        this.unsupported();
    }

    async getClientById(clientId: string): Promise<ClientData | null> {
        const client = await this.clientRepo.findOne({ where: { clientId } });
        return client
            ? {
                  clientId: client.clientId,
                  description: client.description,
                  tenantId: client.tenantId,
                  roles: client.roles,
                  allowedIssuanceConfigs: client.allowedIssuanceConfigs,
                  allowedPresentationConfigs: client.allowedPresentationConfigs,
              }
            : null;
    }

    getClients(_tenantId: string): Promise<ClientData[]> {
        this.unsupported();
    }

    getClient(_tenantId: string, _clientId: string): Promise<ClientData> {
        this.unsupported();
    }

    getClientRoles(
        _tenantId: string,
        _clientId: string,
    ): Promise<string[] | undefined> {
        this.unsupported();
    }

    addClient(_tenantId: string, _dto: CreateClient): Promise<CreatedClient> {
        this.unsupported();
    }

    updateClient(
        _tenantId: string,
        _clientId: string,
        _dto: UpdateClient,
    ): unknown {
        this.unsupported();
    }

    rotateClientSecret(
        _tenantId: string | null,
        _clientId: string,
    ): Promise<string> {
        this.unsupported();
    }

    setClientSecret(
        _tenantId: string,
        _clientId: string,
        _secret: string,
    ): Promise<void> {
        this.unsupported();
    }

    removeClient(_tenantId: string, _clientId: string): Promise<void> {
        this.unsupported();
    }

    /**
     * Nothing to import: a configuration folder is imported through the
     * config bundle plan, which never calls this.
     */
    importForTenant(_tenantId: string): Promise<void> {
        return Promise.resolve();
    }
}
