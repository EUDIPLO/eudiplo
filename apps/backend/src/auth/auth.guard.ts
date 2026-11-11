import {
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

/**
 * Reason for a bearer token that is no JWS in compact form, such as the
 * opaque access tokens Zitadel issues and Auth0 issues without an audience.
 */
export const NOT_A_JWT_MESSAGE =
    "Access token is not a JWT; with an external identity provider, configure it to issue JWT access tokens";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
    constructor(private readonly reflector: Reflector) {
        super();
    }

    canActivate(context: ExecutionContext) {
        const isPublic = this.reflector.getAllAndOverride<boolean>(
            IS_PUBLIC_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (isPublic) {
            return true;
        }
        return super.canActivate(context);
    }

    handleRequest<TUser>(
        err: unknown,
        user: TUser,
        info: unknown,
        context: ExecutionContext,
        status?: unknown,
    ): TUser {
        if (!user) {
            const header: unknown = context.switchToHttp().getRequest()
                .headers?.authorization;
            const token =
                typeof header === "string" && /^bearer /i.test(header)
                    ? header.slice(7).trim()
                    : undefined;
            if (token && token.split(".").length !== 3) {
                throw new UnauthorizedException(NOT_A_JWT_MESSAGE);
            }
            // A reason of the strategy, such as a token of another type.
            if (!err && info instanceof UnauthorizedException) {
                throw info;
            }
        }
        return super.handleRequest(err, user, info, context, status);
    }
}
