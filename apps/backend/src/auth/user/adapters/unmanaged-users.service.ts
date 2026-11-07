import { ManagedUserDto } from "../dto/managed-user.dto.js";
import type { CreateUser, UpdateUser } from "../schemas/create-user.schema.js";
import { UserManagementNotSupported, UsersProvider } from "../user.provider.js";

/**
 * People where EUDIPLO cannot manage them: without `OIDC`, or with
 * `OIDC_PROVIDER=generic`. Every call fails, which the HTTP boundary answers
 * with `501`.
 */
export class UnmanagedUsersProvider extends UsersProvider {
    constructor(private readonly mode: "builtin" | "generic") {
        super();
    }

    private unsupported(): never {
        throw new UserManagementNotSupported(this.mode);
    }

    getUsers(_tenantId: string): Promise<ManagedUserDto[]> {
        this.unsupported();
    }

    getUser(_tenantId: string, _userId: string): Promise<ManagedUserDto> {
        this.unsupported();
    }

    getUserRoles(
        _tenantId: string,
        _userId: string,
    ): Promise<string[] | undefined> {
        this.unsupported();
    }

    addUser(_tenantId: string, _dto: CreateUser): Promise<ManagedUserDto> {
        this.unsupported();
    }

    updateUser(
        _tenantId: string,
        _userId: string,
        _dto: UpdateUser,
    ): Promise<ManagedUserDto> {
        this.unsupported();
    }

    removeUser(_tenantId: string, _userId: string): Promise<void> {
        this.unsupported();
    }
}
