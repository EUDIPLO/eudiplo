import { readFileSync } from "node:fs";
import KeycloakAdminClient from "@keycloak/keycloak-admin-client";
import { Credentials } from "@keycloak/keycloak-admin-client/lib/utils/auth.js";
import {
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { decodeJwt } from "jose";
import { Repository } from "typeorm";
import { ConfigImportService } from "../../../platform/config-import/config-import.service.js";
import { splitCommaSeparatedList } from "../../../shared/domain/comma-separated-list.js";
import { OIDC_DEFAULTS } from "../../auth-settings.js";
import { keycloakAuthorizationRoles } from "../../keycloak-authorization-roles.js";
import { syncEudiploRealmRoles } from "../../keycloak-realm-roles.js";
import { allRoles, Role } from "../../roles/role.enum.js";
import { ClientsProvider } from "../client.provider.js";
import {
    type ClientData,
    ClientIdTaken,
    type CreatedClient,
} from "../domain/client-data.js";
import { CreateClientDto } from "../dto/create-client.dto.js";
import { UpdateClientDto } from "../dto/update-client.dto.js";
import { ClientEntity } from "../entities/client.entity.js";
import {
    webClientAddresses,
    withoutAnyAddress,
} from "../keycloak-ui-client.js";
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

    /** The admin-API client (`OIDC_CLIENT_ID`) or the bootstrap client (`AUTH_CLIENT_ID`). */
    private isInstanceClient(clientId: string): boolean {
        return (
            clientId === this.configService.get<string>("OIDC_CLIENT_ID") ||
            clientId === this.configService.get<string>("AUTH_CLIENT_ID")
        );
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
     * Imports the client files of a tenant's folder that EUDIPLO has no client
     * for yet; `addClient` creates them in Keycloak or takes them over.
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
    private async init() {
        const existingRoles: Role[] = allRoles;
        await this.kc.roles
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
            })
            .catch((err) => {
                this.logger.error("Error initializing Keycloak roles", err);
            });
        // Also when the steps above fail: the client of 9.x accepts any redirect URI.
        await this.ensureUiPublicClient().catch((err) => {
            this.logger.error(
                `Could not update the Keycloak client '${this.uiClientId()}'. Check in Keycloak that its redirect URIs do not contain '*', which lets any website receive sign-ins to the web client.`,
                err,
            );
        });
    }

    /** The public Keycloak client the web client signs in with. */
    private uiClientId(): string {
        return (
            this.configService.get<string>("OIDC_UI_CLIENT_ID") ??
            OIDC_DEFAULTS.uiClientId
        );
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
     *
     * Keycloak sends authorization codes only to the web client URLs of
     * `OIDC_UI_URL`, as anyone can redeem the codes of a public client. Without
     * it, the redirect URIs set in Keycloak stay, except `*`.
     */
    private async ensureUiPublicClient(): Promise<void> {
        const uiClientId = this.uiClientId();
        const webClientUrls = splitCommaSeparatedList(
            this.configService.get<string>("OIDC_UI_URL"),
        );

        const existing = (
            await this.kc.clients.find({ clientId: uiClientId })
        )[0];
        const addresses = webClientUrls.length
            ? webClientAddresses(webClientUrls)
            : withoutAnyAddress(existing);
        if (!addresses.redirectUris.length) {
            this.logger.warn(
                `The Keycloak client '${uiClientId}' has no redirect URIs, so nobody can sign in to the web client with SSO. Set OIDC_UI_URL to the URL of the web client.`,
            );
        }

        const uiClientPayload = {
            clientId: uiClientId,
            name: "EUDIPLO UI",
            description: "Public OIDC client for the Angular management UI",
            publicClient: true,
            serviceAccountsEnabled: false,
            standardFlowEnabled: true,
            directAccessGrantsEnabled: false,
            enabled: true,
            ...addresses,
            // Logging out returns to the web client: "+" allows the redirect URIs.
            attributes: { "post.logout.redirect.uris": "+" },
        };

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
     * Roles of the local mirror plus the roles of the client's service account
     * in Keycloak, which an operator may have changed there. Only clients of
     * the tenant's mirror count, so a tenant cannot reach a Keycloak client
     * without a tenant, such as the bootstrap client.
     */
    async getClientRoles(
        tenantId: string,
        clientId: string,
    ): Promise<string[] | undefined> {
        const client = await this.clientRepo.findOneBy({
            clientId,
            tenant: { id: tenantId },
        });
        if (!client) {
            return undefined;
        }
        const kcClient = (await this.kc.clients.find({ clientId }))[0];
        if (!kcClient?.id) {
            return client.roles;
        }
        this.ensureTenantOwnership(tenantId, kcClient, "managed");
        return [
            ...new Set([
                ...client.roles,
                ...(await this.serviceAccountRoles(kcClient.id)),
            ]),
        ];
    }

    /** Roles of a Keycloak client's service account; none without one. */
    private async serviceAccountRoles(kcClientId: string): Promise<string[]> {
        const svcUser = await this.kc.clients.getServiceAccountUser({
            id: kcClientId,
        });
        return svcUser?.id
            ? keycloakAuthorizationRoles(this.kc, svcUser.id)
            : [];
    }

    /**
     * Roles of the Keycloak client of the tenant that `addClient` adopts,
     * whether the mirror has it or not.
     */
    async getReplacedClientRoles(
        tenantId: string,
        clientId: string,
    ): Promise<string[] | undefined> {
        const kcClient = (await this.kc.clients.find({ clientId }))[0];
        if (!kcClient?.id || !this.isAdoptable(tenantId, kcClient)) {
            return undefined;
        }
        // Keycloak refuses to return the service account of a client that
        // has none enabled; `addClient` enables it on the takeover.
        if (kcClient.serviceAccountsEnabled === false) {
            return [];
        }
        return this.serviceAccountRoles(kcClient.id);
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
     * Only clients EUDIPLO manages for a tenant can be rotated; with a null
     * tenant (tenant managers) any tenant's client, never one of the
     * instance's own clients or a client of another application in the realm.
     * @param tenantId - The caller's tenant, or null for tenant managers
     * @param clientId - The client ID to rotate the secret for
     */
    async rotateClientSecret(
        tenantId: string | null,
        clientId: string,
    ): Promise<string> {
        // Only clients EUDIPLO manages for a tenant: the realm also holds
        // clients of other applications and EUDIPLO's own admin-API and
        // bootstrap clients, which a lookup by clientId alone would reach.
        // All of them answer as unknown, so that the answer does not reveal
        // which IDs the instance uses.
        const mirror = await this.clientRepo.findOneBy({ clientId });
        if (
            !mirror?.tenantId ||
            (tenantId && mirror.tenantId !== tenantId) ||
            this.isInstanceClient(clientId)
        ) {
            throw new NotFoundException(`Client '${clientId}' not found`);
        }

        const kcClient = (await this.kc.clients.find({ clientId }))[0];
        if (!kcClient?.id) {
            throw new NotFoundException(`Client '${clientId}' not found`);
        }

        this.ensureTenantOwnership(
            mirror.tenantId,
            kcClient,
            "rotated (secret)",
        );

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

    /**
     * Whether `addClient` adopts this existing Keycloak client: only one of
     * the tenant, never one without a tenant such as the bootstrap client or
     * the backend's own admin client.
     */
    private isAdoptable(tenantId: string, kcClient: unknown): boolean {
        return this.getTenantOwnerFromKcClient(kcClient) === tenantId;
    }

    async addClient(
        tenantId: string,
        dto: CreateClientDto,
    ): Promise<CreatedClient> {
        // The mirror's primary key is the client ID, so saving the mirror row
        // below would move a client of another tenant.
        const mirrored = await this.clientRepo.findOneBy({
            clientId: dto.clientId,
        });
        if (mirrored && mirrored.tenantId !== tenantId) {
            throw new ClientIdTaken(dto.clientId);
        }
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
            if (!this.isAdoptable(tenantId, existingClient)) {
                throw new ClientIdTaken(dto.clientId);
            }
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

        // 4) Give the service account the EUDIPLO roles of `dto`; an adopted
        // client loses its other EUDIPLO roles, as the mirror below records.
        const svcUser = await this.kc.clients.getServiceAccountUser({ id });
        await syncEudiploRealmRoles(this.kc, svcUser.id!, dto.roles);

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

        // Without roles the update keeps the client's roles, as the internal
        // adapter does.
        if (updateClientDto.roles) {
            const svcUser = await this.kc.clients.getServiceAccountUser({
                id: kcClient.id,
            });
            await syncEudiploRealmRoles(
                this.kc,
                svcUser.id!,
                updateClientDto.roles,
            );
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
