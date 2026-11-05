import { Injectable } from "@nestjs/common";
import { ManagedUserDto } from "../dto/managed-user.dto.js";
import type { CreateUser, UpdateUser } from "../schemas/create-user.schema.js";
import {
    UsersManagedByIdentityProvider,
    UsersProvider,
} from "../user.provider.js";

/** People with `OIDC_PROVIDER=generic`: the identity provider manages them. */
@Injectable()
export class IdpManagedUsersProvider extends UsersProvider {
    private unsupported(): never {
        throw new UsersManagedByIdentityProvider();
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
