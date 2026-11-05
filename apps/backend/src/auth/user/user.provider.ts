import { NotSupportedError } from "../../shared/domain/not-supported-error.js";
import { ManagedUserDto } from "./dto/managed-user.dto.js";
import type { CreateUser, UpdateUser } from "./schemas/create-user.schema.js";

export const USERS_PROVIDER = "USERS_PROVIDER";

/** With `OIDC_PROVIDER=generic`, the identity provider manages the people. */
export class UsersManagedByIdentityProvider extends NotSupportedError {
    constructor() {
        super(
            "Users are managed in the identity provider (OIDC_PROVIDER=generic).",
        );
        this.name = "UsersManagedByIdentityProvider";
    }
}

export abstract class UsersProvider {
    abstract getUsers(tenantId: string): Promise<ManagedUserDto[]>;

    abstract getUser(tenantId: string, userId: string): Promise<ManagedUserDto>;

    /**
     * Roles of a user of the tenant for the authorization check before the
     * user is changed or deleted: its effective EUDIPLO roles, including those
     * from groups and composite roles, plus any client role as
     * `<client>/<role>`.
     * @returns The roles, or `undefined` when the tenant has no such user
     */
    abstract getUserRoles(
        tenantId: string,
        userId: string,
    ): Promise<string[] | undefined>;

    abstract addUser(
        tenantId: string,
        dto: CreateUser,
    ): Promise<ManagedUserDto>;

    abstract updateUser(
        tenantId: string,
        userId: string,
        dto: UpdateUser,
    ): Promise<ManagedUserDto>;

    abstract removeUser(tenantId: string, userId: string): Promise<void>;
}
