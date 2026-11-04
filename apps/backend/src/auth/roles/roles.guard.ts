import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
    meetsRoleRequirement,
    ROLES_KEY,
    RoleRequirement,
} from "./roles.decorator.js";

@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        // A handler's requirement replaces the controller's, roles and match together.
        const requirement = this.reflector.getAllAndOverride<RoleRequirement>(
            ROLES_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (!requirement) {
            return true;
        }
        const { user } = context.switchToHttp().getRequest();
        return meetsRoleRequirement(requirement, user.roles);
    }
}
