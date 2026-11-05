import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Inject,
    NotFoundException,
    Param,
    Patch,
    Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../roles/role.enum.js";
import {
    assertMayChangeRoles,
    assertMayGrantRoles,
    assertMayManageRoles,
    GRANT_DENIED_DESCRIPTION,
    manageDeniedDescription,
} from "../roles/role-grants.js";
import { Secured } from "../secure.decorator.js";
import { requireTenantContext } from "../tenant-context.util.js";
import { Token, TokenPayload } from "../token.decorator.js";
import { CreateUserDto } from "./dto/create-user.dto.js";
import { ManagedUserDto } from "./dto/managed-user.dto.js";
import { UpdateUserDto } from "./dto/update-user.dto.js";
import { USERS_PROVIDER, UsersProvider } from "./user.provider.js";

const MANAGE_DENIED = manageDeniedDescription("user");

@ApiTags("User")
@ApiResponse({
    status: 501,
    description:
        "People are managed only with Keycloak: without `OIDC`, or with `OIDC_PROVIDER=generic`, where the identity provider manages them",
})
@Controller("user")
export class UserController {
    constructor(
        @Inject(USERS_PROVIDER) private readonly users: UsersProvider,
    ) {}

    @ApiOperation({ summary: "Get all managed users for the current tenant" })
    @ApiResponse({ status: 200, type: ManagedUserDto, isArray: true })
    @Secured([Role.Users])
    @Get()
    getUsers(@Token() user: TokenPayload) {
        const tenantId = requireTenantContext(user);
        return this.users.getUsers(tenantId);
    }

    @ApiOperation({ summary: "Get a managed user by id" })
    @ApiResponse({ status: 200, type: ManagedUserDto })
    @Secured([Role.Users])
    @Get(":id")
    getUser(@Param("id") id: string, @Token() user: TokenPayload) {
        const tenantId = requireTenantContext(user);
        return this.users.getUser(tenantId, id);
    }

    @ApiOperation({ summary: "Create a new managed user" })
    @ApiBody({ type: CreateUserDto })
    @ApiResponse({ status: 201, type: ManagedUserDto })
    @ApiResponse({ status: 403, description: GRANT_DENIED_DESCRIPTION })
    @Secured([Role.Users])
    @Post()
    createUser(
        @Body() createUserDto: CreateUserDto,
        @Token() user: TokenPayload,
    ) {
        const tenantId = requireTenantContext(user);
        assertMayGrantRoles(user.roles, createUserDto.roles);
        return this.users.addUser(tenantId, createUserDto);
    }

    @ApiOperation({ summary: "Update a managed user" })
    @ApiBody({ type: UpdateUserDto })
    @ApiResponse({ status: 200, type: ManagedUserDto })
    @ApiResponse({
        status: 403,
        description: `${GRANT_DENIED_DESCRIPTION}. ${MANAGE_DENIED}`,
    })
    @ApiResponse({ status: 404, description: "User not found" })
    @Secured([Role.Users])
    @Patch(":id")
    async updateUser(
        @Param("id") id: string,
        @Body() updateUserDto: UpdateUserDto,
        @Token() user: TokenPayload,
    ) {
        const tenantId = requireTenantContext(user);
        const roles = await this.assertMayManageUser(user, tenantId, id);
        if (!roles) {
            throw new NotFoundException(`User '${id}' not found`);
        }
        if (updateUserDto.roles) {
            assertMayChangeRoles(user.roles, roles, updateUserDto.roles);
        }
        return this.users.updateUser(tenantId, id, updateUserDto);
    }

    @ApiOperation({ summary: "Delete a managed user" })
    @ApiResponse({
        status: 204,
        description: "User deleted, or the tenant has no such user",
    })
    @ApiResponse({ status: 403, description: MANAGE_DENIED })
    @Secured([Role.Users])
    @Delete(":id")
    @HttpCode(204)
    async deleteUser(@Param("id") id: string, @Token() user: TokenPayload) {
        const tenantId = requireTenantContext(user);
        if (!(await this.assertMayManageUser(user, tenantId, id))) return;
        return this.users.removeUser(tenantId, id);
    }

    /**
     * Refuses to act on a user of the tenant that has a role the caller
     * neither holds nor may grant, for example to reset their password.
     * @returns The user's roles, or `undefined` when the tenant has no such user
     */
    private async assertMayManageUser(
        user: TokenPayload,
        tenantId: string,
        userId: string,
    ): Promise<string[] | undefined> {
        const roles = await this.users.getUserRoles(tenantId, userId);
        if (roles) {
            assertMayManageRoles(user.roles, roles, `user ${userId}`);
        }
        return roles;
    }
}
