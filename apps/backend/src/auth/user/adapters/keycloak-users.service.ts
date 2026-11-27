import { randomBytes } from "node:crypto";
import KeycloakAdminClient from "@keycloak/keycloak-admin-client";
import { Credentials } from "@keycloak/keycloak-admin-client/lib/utils/auth.js";
import {
    ConflictException,
    Injectable,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decodeJwt } from "jose";
import { keycloakAuthorizationRoles } from "../../keycloak-authorization-roles.js";
import { syncEudiploRealmRoles } from "../../keycloak-realm-roles.js";
import { ROLE_MODEL_11_MARKER } from "../../keycloak-role-model-upgrade.js";
import { allRoles, isRole, Role } from "../../roles/role.enum.js";
import { ManagedUserDto } from "../dto/managed-user.dto.js";
import type { CreateUser, UpdateUser } from "../schemas/create-user.schema.js";
import { UsersProvider } from "../user.provider.js";

@Injectable()
export class KeycloakUsersProvider extends UsersProvider {
    private kc!: KeycloakAdminClient;

    constructor(private readonly configService: ConfigService) {
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
        await this.ensureTenantOwnershipAttribute();
        const accessToken = await this.kc.getAccessToken();
        const payload = decodeJwt(accessToken!);
        const refreshMs =
            Math.max(5, payload.exp! - Date.now() / 1000 - 10) * 1000;

        setInterval(async () => {
            try {
                await this.kc.auth(creds);
            } catch {
                // ignore; next interval will retry
            }
        }, refreshMs);
    }

    async getUsers(tenantId: string): Promise<ManagedUserDto[]> {
        const users = await this.kc.users.find({ max: 1000 });
        const tenantUsers = users.filter(
            (user) =>
                !user.serviceAccountClientId &&
                this.getTenantOwnerFromKcUser(user) === tenantId,
        );
        return Promise.all(tenantUsers.map((user) => this.mapUser(user)));
    }

    async getUser(tenantId: string, userId: string): Promise<ManagedUserDto> {
        const user = await this.kc.users.findOne({ id: userId });
        if (!user?.id) {
            throw new NotFoundException(`User '${userId}' not found`);
        }

        this.ensureTenantOwnership(tenantId, user, "viewed");
        return this.mapUser(user);
    }

    async getUserRoles(
        tenantId: string,
        userId: string,
    ): Promise<string[] | undefined> {
        const user = await this.kc.users.findOne({ id: userId });
        if (!user?.id) {
            return undefined;
        }

        this.ensureTenantOwnership(tenantId, user, "managed");
        return keycloakAuthorizationRoles(this.kc, user.id);
    }

    async addUser(tenantId: string, dto: CreateUser): Promise<ManagedUserDto> {
        const existing = (
            await this.kc.users.find({ username: dto.username, exact: true })
        )[0];
        if (existing?.id) {
            throw new ConflictException(
                `User '${dto.username}' already exists`,
            );
        }

        const created = await this.kc.users.create({
            username: dto.username,
            email: this.resolveUserEmail(
                { username: dto.username, email: undefined },
                tenantId,
            ),
            enabled: dto.enabled ?? true,
            attributes: { tenant_id: [tenantId] },
        });

        const userId =
            created.id ??
            (
                await this.kc.users.find({
                    username: dto.username,
                    exact: true,
                })
            )[0]?.id;
        if (!userId) {
            throw new Error(
                `User '${dto.username}' creation did not return an id`,
            );
        }

        await this.kc.users.update(
            { id: userId },
            { attributes: { tenant_id: [tenantId] } },
        );

        const temporaryPassword = this.generateTemporaryPassword();

        await this.kc.users.resetPassword({
            id: userId,
            credential: {
                temporary: true,
                type: "password",
                value: temporaryPassword,
            },
        });

        await this.syncRoles(userId, dto.roles ?? []);

        const createdUser = await this.getUser(tenantId, userId);
        return {
            ...createdUser,
            temporaryPassword,
        };
    }

    async updateUser(
        tenantId: string,
        userId: string,
        dto: UpdateUser,
    ): Promise<ManagedUserDto> {
        const user = await this.kc.users.findOne({ id: userId });
        if (!user?.id) {
            throw new NotFoundException(`User '${userId}' not found`);
        }

        this.ensureTenantOwnership(tenantId, user, "updated");

        await this.kc.users.update(
            { id: userId },
            {
                email: this.resolveUserEmail(user, tenantId),
                enabled: dto.enabled ?? user.enabled,
                attributes: { tenant_id: [tenantId] },
            },
        );

        if (dto.password) {
            await this.kc.users.resetPassword({
                id: userId,
                credential: {
                    temporary: false,
                    type: "password",
                    value: dto.password,
                },
            });
        }

        if (dto.roles) {
            await this.syncRoles(userId, dto.roles);
        }

        return this.getUser(tenantId, userId);
    }

    async removeUser(tenantId: string, userId: string): Promise<void> {
        const user = await this.kc.users.findOne({ id: userId });
        if (!user?.id) {
            return;
        }

        this.ensureTenantOwnership(tenantId, user, "deleted");
        await this.kc.users.del({ id: userId });
    }

    private getTenantOwnerFromKcUser(user: any): string | undefined {
        const attrs = user?.attributes;
        const tenantAttr = attrs?.tenant_id;

        if (Array.isArray(tenantAttr)) {
            return tenantAttr[0];
        }

        if (typeof tenantAttr === "string") {
            return tenantAttr;
        }

        return undefined;
    }

    private async ensureTenantOwnershipAttribute(): Promise<void> {
        const profile = await this.kc.users.getProfile();
        if (
            profile.attributes?.some(
                (attribute) => attribute.name === "tenant_id",
            )
        ) {
            return;
        }

        await this.kc.users.updateProfile({
            ...profile,
            attributes: [
                ...(profile.attributes ?? []),
                {
                    name: "tenant_id",
                    displayName: "Tenant ID",
                    multivalued: false,
                    permissions: { view: ["admin"], edit: ["admin"] },
                },
            ],
        });
    }

    private ensureTenantOwnership(
        tenantId: string,
        user: any,
        action: string,
    ): void {
        const ownerTenantId = this.getTenantOwnerFromKcUser(user);
        if (!ownerTenantId) {
            throw new ConflictException(
                `User '${user.username}' has no tenant ownership metadata and cannot be ${action} by tenant '${tenantId}'.`,
            );
        }

        if (ownerTenantId === tenantId) {
            return;
        }

        throw new ConflictException(
            `User '${user.username}' is managed by tenant '${ownerTenantId}' and cannot be ${action} by tenant '${tenantId}'.`,
        );
    }

    private resolveUserEmail(
        user: { username?: string; email?: string },
        tenantId: string,
    ): string {
        const email = user.email?.trim().toLowerCase();
        if (email) {
            return email;
        }

        const username = user.username?.trim();
        if (!username) {
            throw new Error(
                "Keycloak user update requires a username to derive email",
            );
        }

        return this.buildEmailFromUsername(username, tenantId);
    }

    private generateTemporaryPassword(): string {
        const alphabet =
            "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
        const bytes = randomBytes(14);
        return Array.from(bytes, (byte) => alphabet[byte % alphabet.length])
            .join("")
            .slice(0, 12);
    }

    private buildEmailFromUsername(username: string, tenantId: string): string {
        const normalizedUsername = username.trim().toLowerCase();
        const atIndex = normalizedUsername.indexOf("@");
        const isEmailLike =
            atIndex > 0 &&
            atIndex === normalizedUsername.lastIndexOf("@") &&
            normalizedUsername.indexOf(".", atIndex + 1) > atIndex + 1 &&
            !normalizedUsername.includes(" ");

        if (isEmailLike) {
            return normalizedUsername;
        }

        const localPart =
            normalizedUsername
                .replace(/[^a-z0-9._+-]+/g, "-")
                .replace(/^-/, "")
                .replace(/-$/, "") || "user";
        const tenantPart =
            tenantId
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-/, "")
                .replace(/-$/, "") || "tenant";

        return `${localPart}+${tenantPart}@eudiplo.local`;
    }

    private async mapUser(user: any): Promise<ManagedUserDto> {
        const roles = await this.kc.users.listRealmRoleMappings({
            id: user.id!,
        });
        return {
            id: user.id!,
            username: user.username!,
            email: user.email,
            enabled: user.enabled ?? true,
            // Only EUDIPLO roles; Keycloak's default roles cannot be granted.
            roles: roles.map((role) => role.name).filter(isRole),
            tenantId: this.getTenantOwnerFromKcUser(user),
        };
    }

    private async syncRoles(userId: string, nextRoles: Role[]): Promise<void> {
        await this.ensureRealmRoles(nextRoles);
        await syncEudiploRealmRoles(this.kc, userId, nextRoles);
    }

    private async ensureRealmRoles(requestedRoles: Role[]): Promise<void> {
        const existingRoles = await this.kc.roles.find();
        const targetRoles =
            requestedRoles.length > 0 ? requestedRoles : allRoles;
        // keys:export marks the realm as upgraded to the 11.0 role model:
        // only the clients adapter creates it, after the upgrade.
        const missingRoles = targetRoles.filter(
            (role) =>
                role !== ROLE_MODEL_11_MARKER &&
                !existingRoles.some(
                    (existingRole) => existingRole.name === role,
                ),
        );

        if (missingRoles.length === 0) {
            return;
        }

        await Promise.all(
            missingRoles.map((role) => this.kc.roles.create({ name: role })),
        );
    }
}
