import { readFileSync } from "node:fs";
import KeycloakAdminClient from "@keycloak/keycloak-admin-client";
import { Credentials } from "@keycloak/keycloak-admin-client/lib/utils/auth.js";
import {
    ConflictException,
    Injectable,
    Logger,
    OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { decodeJwt } from "jose";
import { Repository } from "typeorm";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import { allRoles, Role } from "../../roles/role.enum.js";
import { ClientsProvider } from "../client.provider.js";
import type { ClientData, CreatedClient } from "../domain/client-data.js";
import { CreateClientDto } from "../dto/create-client.dto.js";
import { UpdateClientDto } from "../dto/update-client.dto.js";
import { ClientEntity } from "../entities/client.entity.js";
import { CreateClientSchema } from "../schemas/client.schema.js";

@Injectable()
export class KeycloakClientsProvider
    extends ClientsProvider
    implements OnModuleInit
{
    private kc!: KeycloakAdminClient;
    private readonly logger = new Logger(KeycloakClientsProvider.name);

    private getTenantOwnerFromKcClient(kcClient: any): string | undefined {
        const attrs = kcClient?.attributes;
        const tenantAttr = attrs?.tenant_id;

        if (Array.isArray(tenantAttr)) {
            return tenantAttr[0];
        }

        if (typeof tenantAttr === "string") {
            return tenantAttr;
        }

        return undefined;
    }

    private ensureTenantOwnership(
        tenantId: string,
        kcClient: any,
        action: string,
    ): void {
        const ownerTenantId = this.getTenantOwnerFromKcClient(kcClient);

        if (!ownerTenantId || ownerTenantId === tenantId) {
            return;
        }

        throw new ConflictException(
            `Client '${kcClient.clientId}' is managed by tenant '${ownerTenantId}' and cannot be ${action} by tenant '${tenantId}'.`,
        );
    }

    constructor(
        private readonly configService: ConfigService,
        @InjectRepository(ClientEntity)
        private readonly clientRepo: Repository<ClientEntity>,
        private readonly configImportService: ConfigImportService,
    ) {
        super();
    }

    async onModuleInit() {
        const oidc = this.configService.getOrThrow<string>("OIDC");
        const [baseUrl, realmName] = oidc.split("/realms/");
        this.kc = new KeycloakAdminClient({ baseUrl, realmName });

        const creds: Credentials = {
            grantType: "client_credentials",
            clientId: this.configService.getOrThrow("OIDC_CLIENT_ID"),
            clientSecret: this.configService.getOrThrow("OIDC_CLIENT_SECRET"),
        };

        await this.kc.auth(creds);
        const accessToken = await this.kc.getAccessToken();
        const payload = decodeJwt(accessToken!);
        const refreshMs =
            Math.max(5, payload.exp! - Date.now() / 1000 - 10) * 1000;
        // Refresh a bit before expiry
        setInterval(async () => {
            try {
                await this.kc.auth(creds);
            } catch {
                // log & keep trying on next tick.
            }
        }, refreshMs);
        await this.init();
    }

    /**
     * Imports clients for a tenant. No-op for Keycloak as clients are managed directly in Keycloak.
     */
    async importForTenant(tenantId: string): Promise<void> {
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
                checkExists: async (currentTenantId, data) => {
                    return this.getClientById((data as any).clientId)
                        .then((client) => !!client)
                        .catch(() => false);
                },
                deleteExisting: async (currentTenantId, data) => {
                    await this.removeClient(
                        currentTenantId,
                        (data as any).clientId,
                    );
                },
                processItem: async (currentTenantId, data) => {
                    await this.addClient(currentTenantId, {
                        clientId: (data as any).clientId,
                        secret: (data as any).secret,
                        description: (data as any).description,
                        roles: (data as any).roles,
                        allowedIssuanceConfigs: (data as any)
                            .allowedIssuanceConfigs,
                        allowedPresentationConfigs: (data as any)
                            .allowedPresentationConfigs,
                    });
                },
            },
        );
    }

    /**
     * Checks if all the roles are available in the realm. If not they will be created.
     */
    private init() {
        const existingRoles: Role[] = allRoles;
        return this.kc.roles
            .find()
            .then(async (roles) => {
                // Check if all roles exist
                const missingRoles = existingRoles.filter(
                    (role) => !roles.some((r) => r.name === role),
                );
                if (missingRoles.length) {
                    // Create missing roles
                    await Promise.all(
                        missingRoles.map((role) =>
                            this.kc.roles.create({ name: role }),
                        ),
                    );
                }

                await this.ensureBootstrapAdminClient();
                await this.ensureUiPublicClient();
            })
            .catch((err) => {
                this.logger.error("Error initializing Keycloak roles", err);
            });
    }

    /**
     * In OIDC mode, optionally bootstrap a Keycloak admin/root client from AUTH_CLIENT_ID/SECRET.
     * This client can be used to obtain tenant-management tokens via Keycloak.
     */
    private async ensureBootstrapAdminClient() {
        const bootstrapClientId =
            this.configService.get<string>("AUTH_CLIENT_ID");
        const bootstrapClientSecret =
            this.configService.get<string>("AUTH_CLIENT_SECRET");

        if (!bootstrapClientId && !bootstrapClientSecret) {
            return;
        }

        if (!bootstrapClientId || !bootstrapClientSecret) {
            this.logger.warn(
                "Skipping bootstrap admin client setup: AUTH_CLIENT_ID and AUTH_CLIENT_SECRET must both be set in OIDC mode.",
            );
            return;
        }

        const existingClient = (
            await this.kc.clients.find({ clientId: bootstrapClientId })
        )[0];

        const bootstrapClientPayload = {
            clientId: bootstrapClientId,
            description: "Bootstrap admin client for tenant management",
            serviceAccountsEnabled: true,
            enabled: true,
            publicClient: false,
            directAccessGrantsEnabled: false,
            standardFlowEnabled: false,
            webOrigins: ["*"],
            secret: bootstrapClientSecret,
        };

        let clientId = existingClient?.id;
        if (clientId) {
            await this.kc.clients.update(
                { id: clientId },
                bootstrapClientPayload,
            );
        } else {
            const created = await this.kc.clients.create(
                bootstrapClientPayload,
            );
            clientId = created.id;
        }

        if (!clientId) {
            return;
        }

        const serviceAccountUser = await this.kc.clients.getServiceAccountUser({
            id: clientId,
        });
        const allRealmRoles = await this.kc.roles.find();
        const bootstrapRoleNames = [Role.Tenants];
        const bootstrapRoles = bootstrapRoleNames
            .map((name) => allRealmRoles.find((r) => r.name === name))
            .filter((r): r is NonNullable<typeof r> => !!r?.id && !!r?.name);

        if (!serviceAccountUser.id || bootstrapRoles.length === 0) {
            return;
        }

        const currentRoles = await this.kc.users.listRealmRoleMappings({
            id: serviceAccountUser.id,
        });

        const missingRoles = bootstrapRoles.filter(
            (r) => !currentRoles.some((cr) => cr.name === r.name),
        );

        if (missingRoles.length > 0) {
            await this.kc.users.addRealmRoleMappings({
                id: serviceAccountUser.id,
                roles: missingRoles.map((r) => ({ id: r.id!, name: r.name! })),
            });
        }
    }

    /**
     * Auto-create or update a public Keycloak client for the Angular UI (Authorization Code + PKCE).
     */
    private async ensureUiPublicClient(): Promise<void> {
        const uiClientId =
            this.configService.get<string>("OIDC_UI_CLIENT_ID") ?? "eudiplo-ui";

        const uiClientPayload = {
            clientId: uiClientId,
            name: "EUDIPLO UI",
            description: "Public OIDC client for the Angular management UI",
            publicClient: true,
            serviceAccountsEnabled: false,
            standardFlowEnabled: true,
            directAccessGrantsEnabled: false,
            enabled: true,
            redirectUris: ["*"],
            webOrigins: ["*"],
        };

        const existing = (
            await this.kc.clients.find({ clientId: uiClientId })
        )[0];
        if (existing?.id) {
            await this.kc.clients.update({ id: existing.id }, uiClientPayload);
            this.logger.log(`Updated public UI client '${uiClientId}'`);
        } else {
            await this.kc.clients.create(uiClientPayload);
            this.logger.log(`Created public UI client '${uiClientId}'`);
        }
    }

    async getClients(tenantId: string): Promise<ClientData[]> {
        const clients = await this.clientRepo.find({
            where: { tenant: { id: tenantId } },
        });
        return clients.map((client) => this.toClientData(client, tenantId));
    }

    async getClient(tenantId: string, clientId: string): Promise<ClientData> {
        const client = await this.clientRepo.findOneByOrFail({
            clientId,
            tenant: { id: tenantId },
        });
        return this.toClientData(client, tenantId);
    }

    /**
     * Get a client by its clientId only (without tenant context).
     * Used for JWT validation to fetch client restrictions.
     */
    async getClientById(clientId: string): Promise<ClientData | null> {
        const client = await this.clientRepo.findOne({ where: { clientId } });
        return client ? this.toClientData(client) : null;
    }

    /**
     * Rotate (regenerate) a client's secret in Keycloak.
     * Returns the new plain secret for one-time display.
     * @param _tenantId - Ignored for Keycloak (clients are global)
     * @param clientId - The client ID to rotate the secret for
     */
    async rotateClientSecret(
        tenantId: string | null,
        clientId: string,
    ): Promise<string> {
        const kcClient = (await this.kc.clients.find({ clientId }))[0];
        if (!kcClient?.id) {
            throw new Error(`Client ${clientId} not found in Keycloak`);
        }

        if (tenantId) {
            this.ensureTenantOwnership(tenantId, kcClient, "rotated (secret)");
        }

        const secret = await this.kc.clients.generateNewClientSecret({
            id: kcClient.id,
        });
        return secret.value!;
    }

    async setClientSecret(
        tenantId: string,
        clientId: string,
        secret: string,
    ): Promise<void> {
        const client = (await this.kc.clients.find({ clientId }))[0];
        if (!client?.id) {
            throw new Error(`Client ${clientId} not found in Keycloak`);
        }
        this.ensureTenantOwnership(tenantId, client, "updated (secret)");
        await this.kc.clients.update({ id: client.id }, { secret });
    }

    async addClient(
        tenantId: string,
        dto: CreateClientDto,
    ): Promise<CreatedClient> {
        const clientPayload = {
            clientId: dto.clientId,
            description: dto.description,
            serviceAccountsEnabled: true,
            enabled: true,
            publicClient: false,
            directAccessGrantsEnabled: false,
            standardFlowEnabled: false,
            webOrigins: ["*"],
            secret: dto.secret,
            attributes: { tenant_id: tenantId },
            protocolMappers: [
                // hardcode tenant_id claim into tokens
                {
                    name: "tenant_id",
                    protocol: "openid-connect",
                    protocolMapper: "oidc-hardcoded-claim-mapper",
                    config: {
                        "claim.value": tenantId,
                        "claim.name": "tenant_id",
                        "jsonType.label": "String",
                        "id.token.claim": "true",
                        "access.token.claim": "true",
                    },
                },
                // expose realm roles as "roles" claim
                {
                    name: "realm-roles",
                    protocol: "openid-connect",
                    protocolMapper: "oidc-usermodel-realm-role-mapper",
                    config: {
                        "claim.name": "roles",
                        "jsonType.label": "String",
                        "id.token.claim": "true",
                        multivalued: "true",
                        "access.token.claim": "true",
                    },
                },
            ],
        };

        let id: string;
        let createdNow = false;
        try {
            const created = await this.kc.clients.create(clientPayload);
            if (!created.id) {
                throw new Error(
                    `Client ${dto.clientId} creation did not return an id`,
                );
            }
            id = created.id;
            createdNow = true;
        } catch (error: any) {
            const status = error?.response?.status || error?.status;
            const message = `${error?.message || ""}`;
            const isConflict = status === 409 || message.includes("409");

            if (!isConflict) {
                throw error;
            }

            this.logger.warn(
                `Client ${dto.clientId} already exists in Keycloak; reconciling and updating local mirror`,
            );

            const existingClient = (
                await this.kc.clients.find({ clientId: dto.clientId })
            )[0];
            if (!existingClient?.id) {
                throw error;
            }
            this.ensureTenantOwnership(tenantId, existingClient, "updated");
            id = existingClient.id;

            await this.kc.clients.update(
                { id },
                {
                    description: dto.description,
                    serviceAccountsEnabled: true,
                    enabled: true,
                    publicClient: false,
                    directAccessGrantsEnabled: false,
                    standardFlowEnabled: false,
                    webOrigins: ["*"],
                    attributes: { tenant_id: tenantId },
                },
            );
        }

        // 3) Generate secret once (show only on creation)
        const secret = dto.secret
            ? { value: dto.secret }
            : createdNow
              ? await this.kc.clients.generateNewClientSecret({ id })
              : { value: undefined };

        // 4) Assign realm roles to the service account user
        const svcUser = await this.kc.clients.getServiceAccountUser({ id });
        const allRealmRoles = await this.kc.roles.find();
        const toAssign = dto.roles
            .map((r) => allRealmRoles.find((ar) => ar.name === r))
            .filter(Boolean) as { id?: string; name?: string }[];

        if (toAssign.length) {
            await this.kc.users.addRealmRoleMappings({
                id: svcUser.id!,
                roles: toAssign.map((r) => ({ id: r.id!, name: r.name! })),
            });
        }

        // 5) (Optional) Put a mirror row in your DB (no secret)
        const entity = this.clientRepo.create({
            clientId: dto.clientId,
            description: dto.description,
            roles: dto.roles,
            allowedPresentationConfigs: dto.allowedPresentationConfigs,
            allowedIssuanceConfigs: dto.allowedIssuanceConfigs,
            tenant: { id: tenantId },
        });
        await this.clientRepo.save(entity);

        return {
            clientId: dto.clientId,
            description: dto.description,
            tenantId,
            roles: dto.roles,
            allowedPresentationConfigs: dto.allowedPresentationConfigs,
            allowedIssuanceConfigs: dto.allowedIssuanceConfigs,
            clientSecret: secret.value,
        };
    }

    private toClientData(
        client: ClientEntity,
        tenantId = client.tenantId,
    ): ClientData {
        return {
            clientId: client.clientId,
            tenantId,
            description: client.description,
            roles: client.roles,
            allowedPresentationConfigs: client.allowedPresentationConfigs,
            allowedIssuanceConfigs: client.allowedIssuanceConfigs,
        };
    }

    async updateClient(
        tenantId: string,
        clientId: string,
        updateClientDto: UpdateClientDto,
    ) {
        const client = await this.getClient(tenantId, clientId);
        // Get service account user
        const kcClient = (await this.kc.clients.find({ clientId }))[0];
        if (!kcClient?.id) {
            this.logger.warn(
                `Client '${clientId}' exists in the local mirror but not in Keycloak; recreating it.`,
            );
            await this.clientRepo.delete({
                clientId,
                tenant: { id: tenantId },
            });
            return this.addClient(tenantId, {
                clientId,
                description:
                    updateClientDto.description ??
                    client.description ??
                    undefined,
                roles: updateClientDto.roles ?? client.roles,
                allowedPresentationConfigs:
                    updateClientDto.allowedPresentationConfigs ??
                    client.allowedPresentationConfigs,
                allowedIssuanceConfigs:
                    updateClientDto.allowedIssuanceConfigs ??
                    client.allowedIssuanceConfigs,
            });
        }
        this.ensureTenantOwnership(tenantId, kcClient, "updated");
        const svcUser = await this.kc.clients.getServiceAccountUser({
            id: kcClient.id,
        });

        // Get all realm roles
        const allRealmRoles = await this.kc.roles.find();

        // Roles to assign
        const newRoles = updateClientDto.roles || [];
        const toAssign = newRoles
            .map((r) => allRealmRoles.find((ar) => ar.name === r))
            .filter(Boolean) as { id?: string; name?: string }[];

        // Get currently assigned roles
        const currentRoles = await this.kc.users.listRealmRoleMappings({
            id: svcUser.id!,
        });

        // Roles to remove
        const toRemove = currentRoles
            .filter((cr) => !newRoles.includes(cr.name as Role))
            .map((r) => ({ id: r.id!, name: r.name! }));

        // Remove roles no longer assigned
        if (toRemove.length) {
            await this.kc.users.delRealmRoleMappings({
                id: svcUser.id!,
                roles: toRemove,
            });
        }

        // Add new roles
        if (toAssign.length) {
            await this.kc.users.addRealmRoleMappings({
                id: svcUser.id!,
                roles: toAssign.map((r) => ({ id: r.id!, name: r.name! })),
            });
        }

        // Update client in Keycloak
        await this.kc.clients.update(
            { id: kcClient.id },
            {
                description:
                    updateClientDto.description ??
                    client.description ??
                    undefined,
            },
        );

        // Optionally update your DB mirror
        await this.clientRepo.update(
            { clientId, tenant: { id: tenantId } },
            { ...updateClientDto },
        );

        return this.getClient(tenantId, clientId);
    }

    async removeClient(tenantId: string, clientId: string) {
        const kcClient = (await this.kc.clients.find({ clientId }))[0];
        if (kcClient?.id) {
            this.ensureTenantOwnership(tenantId, kcClient, "deleted");
            await this.kc.clients.del({ id: kcClient.id });
        }
        await this.clientRepo.delete({ clientId, tenant: { id: tenantId } });
    }
}
