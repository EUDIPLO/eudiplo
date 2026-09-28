import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { IsNull, Repository } from "typeorm";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import { Role } from "../../roles/role.enum.js";
import { ClientsProvider } from "../client.provider.js";
import type { ClientData, CreatedClient } from "../domain/client-data.js";
import { ClientEntity } from "../entities/client.entity.js";
import type { CreateClient, UpdateClient } from "../schemas/client.schema.js";
import { CreateClientSchema } from "../schemas/client.schema.js";

const BCRYPT_ROUNDS = 10;

@Injectable()
export class InternalClientsProvider
    extends ClientsProvider
    implements OnApplicationBootstrap
{
    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(ClientEntity)
        private readonly repo: Repository<ClientEntity>,
        private readonly configImportService: ConfigImportService,
    ) {
        super();
    }

    async onApplicationBootstrap() {
        // Add the root admin user (tenant-less, for managing tenants)
        const clientId = this.configService.getOrThrow("AUTH_CLIENT_ID");
        const clientSecret =
            this.configService.getOrThrow("AUTH_CLIENT_SECRET");

        // Check if admin client already exists (no tenant association)
        const existingAdmin = await this.repo.findOne({
            where: { clientId, tenantId: IsNull() },
        });

        if (!existingAdmin) {
            // Hash the root client secret before storing
            const hashedSecret = await bcrypt.hash(clientSecret, BCRYPT_ROUNDS);
            await this.repo.save({
                clientId,
                secret: hashedSecret,
                description: "Admin client for tenant management",
                roles: [Role.Tenants],
                // No tenant - this is the bootstrap admin
            });
        }
    }

    async importForTenant(tenantId: string) {
        await this.configImportService.importConfigsForTenant<ClientEntity>(
            tenantId,
            {
                subfolder: "clients",
                fileExtension: ".json",
                validationSchema: CreateClientSchema,
                resourceType: "client config",
                loadData: (filePath) => {
                    const payload = JSON.parse(readFileSync(filePath, "utf8"));
                    return payload as ClientEntity;
                },
                checkExists: async (tenantId, data) => {
                    return this.getClient(tenantId, (data as any).clientId)
                        .then(() => true)
                        .catch(() => false);
                },
                deleteExisting: async (tenantId, data) => {
                    await this.repo.delete({
                        clientId: (data as any).clientId,
                        tenant: { id: tenantId },
                    });
                },
                processItem: async (tenantId, data, file) => {
                    const secret =
                        (data as any).secret ?? randomBytes(32).toString("hex");
                    // Hash the secret before storing
                    const hashedSecret = await bcrypt.hash(
                        secret,
                        BCRYPT_ROUNDS,
                    );
                    await this.repo.save({
                        ...(data as any),
                        secret: hashedSecret,
                        tenant: { id: tenantId },
                    });
                },
            },
        );
    }

    getClients(tenantId: string): Promise<ClientData[]> {
        return this.repo
            .find({ where: { tenant: { id: tenantId } } })
            .then((list) =>
                list.map((client) => this.toClientData(client, tenantId)),
            );
    }

    getClient(tenantId: string, clientId: string): Promise<ClientData> {
        return this.repo
            .findOneByOrFail({ clientId, tenant: { id: tenantId } })
            .then((client) => this.toClientData(client, tenantId));
    }

    /**
     * Get a client by its clientId only (without tenant context).
     * Used for JWT validation to fetch client restrictions.
     */
    async getClientById(clientId: string): Promise<ClientData | null> {
        const client = await this.repo.findOne({ where: { clientId } });
        return client ? this.toClientData(client) : null;
    }

    async addClient(
        tenantId: string,
        dto: CreateClient,
        secret = dto.secret ?? randomBytes(32).toString("hex"),
    ): Promise<CreatedClient> {
        // Hash the secret before storing
        const hashedSecret = await bcrypt.hash(secret, BCRYPT_ROUNDS);
        const entity = await this.repo.save({
            ...dto,
            secret: hashedSecret,
            tenant: { id: tenantId },
        });
        return {
            clientId: entity.clientId,
            description: entity.description,
            tenantId,
            roles: entity.roles,
            // Return the plain secret only during creation (one-time view)
            clientSecret: secret,
        };
    }

    private toClientData(
        client: ClientEntity,
        tenantId = client.tenantId,
    ): ClientData {
        return {
            clientId: client.clientId,
            description: client.description,
            tenantId,
            roles: client.roles,
            allowedPresentationConfigs: client.allowedPresentationConfigs,
            allowedIssuanceConfigs: client.allowedIssuanceConfigs,
        };
    }

    /**
     * Rotate (regenerate) a client's secret.
     * Returns the new plain secret for one-time display.
     * @param tenantId - The tenant ID (null for tenant managers who can rotate any client's secret)
     * @param clientId - The client ID to rotate the secret for
     */
    async rotateClientSecret(
        tenantId: string | null,
        clientId: string,
    ): Promise<string> {
        // Build query - if tenantId is null, allow cross-tenant access (for tenant managers)
        const whereClause: { clientId: string; tenant?: { id: string } } = {
            clientId,
        };
        if (tenantId) {
            whereClause.tenant = { id: tenantId };
        }

        await this.repo.findOneByOrFail(whereClause);
        const newSecret = randomBytes(32).toString("hex");
        const hashedSecret = await bcrypt.hash(newSecret, BCRYPT_ROUNDS);
        await this.repo.update({ clientId }, { secret: hashedSecret });
        return newSecret;
    }

    async setClientSecret(
        tenantId: string,
        clientId: string,
        secret: string,
    ): Promise<void> {
        await this.repo.findOneByOrFail({
            clientId,
            tenant: { id: tenantId },
        });
        await this.repo.update(
            { clientId, tenant: { id: tenantId } },
            { secret: await bcrypt.hash(secret, BCRYPT_ROUNDS) },
        );
    }

    updateClient(
        tenantId: string,
        clientId: string,
        updateClientDto: UpdateClient,
    ) {
        return this.repo.update(
            { clientId, tenant: { id: tenantId } },
            updateClientDto,
        );
    }

    async removeClient(tenantId: string, clientId: string) {
        await this.repo.delete({ clientId, tenant: { id: tenantId } });
    }

    async validateClientCredentials(
        clientId: string,
        clientSecret: string,
    ): Promise<ClientData | null> {
        const client = await this.repo.findOne({ where: { clientId } });
        if (!client?.secret) {
            return null;
        }
        const isValid = await bcrypt.compare(clientSecret, client.secret);
        return isValid ? this.toClientData(client) : null;
    }
}
