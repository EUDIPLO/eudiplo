import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { tenantConfigFolder } from "../../../shared/utils/tenant-config-folder.util.js";
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
        private readonly configService: ConfigService,
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
     * Client files in a tenant's configuration folder would have no effect,
     * so the import fails instead of letting the operator assume the clients
     * exist.
     */
    importForTenant(tenantId: string): Promise<void> {
        const folder = tenantConfigFolder(
            this.configService.getOrThrow<string>("CONFIG_FOLDER"),
            tenantId,
        );
        const clients = folder ? join(folder, "clients") : undefined;
        if (
            clients &&
            existsSync(clients) &&
            readdirSync(clients).some((file) => file.endsWith(".json"))
        ) {
            return Promise.reject(
                new Error(
                    `${clients} contains client files, but with OIDC_PROVIDER=generic clients are managed in the identity provider. Delete the folder, or set OIDC_PROVIDER=keycloak.`,
                ),
            );
        }
        return Promise.resolve();
    }
}
