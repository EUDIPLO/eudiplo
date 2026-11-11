import {
    CanActivate,
    ExecutionContext,
    Injectable,
    SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { requireTenantContext } from "./tenant-context.util.js";
import type { TokenPayload } from "./token.decorator.js";

export const TENANT_CONTEXT_KEY = "tenantContext";

/**
 * `required`: the route works on the caller's tenant and refuses a token
 * without one. `optional`: the route also serves callers without a tenant,
 * such as the `tenants:manage` operator, and checks the tenant itself where
 * it needs one.
 */
export type TenantContext = "required" | "optional";

export const TenantContextRequirement = (tenant: TenantContext) =>
    SetMetadata(TENANT_CONTEXT_KEY, tenant);

/**
 * Refuses a token without a tenant with 403 on routes that need one: a token
 * of the root client, or an identity provider's token whose tenant claim is
 * missing or names a tenant that does not exist. Without it, handlers that
 * read the caller's tenant would fail with a 500.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        // A handler's requirement replaces the controller's.
        const tenant = this.reflector.getAllAndOverride<TenantContext>(
            TENANT_CONTEXT_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (tenant !== "required") {
            return true;
        }
        const { user } = context.switchToHttp().getRequest<{
            user: TokenPayload;
        }>();
        requireTenantContext(user);
        return true;
    }
}
