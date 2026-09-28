import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { TokenPayload } from "../auth/token.decorator.js";
import type {
    AuditLogActor,
    AuditLogRequestMeta,
} from "./audit-log.service.js";

export function resolveAuditActor(token: TokenPayload): AuditLogActor {
    const clientId = token.client?.clientId || token.authorizedParty;

    if (token.subject && clientId && token.subject !== clientId) {
        return {
            type: "user",
            id: token.subject,
            display: clientId,
        };
    }

    if (clientId) {
        return {
            type: "client",
            id: clientId,
            display: clientId,
        };
    }

    if (token.subject) {
        return {
            type: "user",
            id: token.subject,
        };
    }

    return { type: "system" };
}

export function extractRequestMeta(
    req?: Request,
): AuditLogRequestMeta | undefined {
    if (!req) return undefined;

    return {
        requestId: req.headers["x-request-id"]
            ? String(req.headers["x-request-id"])
            : undefined,
    };
}

/**
 * Controller parameter decorator that extracts transport-neutral audit metadata
 * so services receive {@link AuditLogRequestMeta} instead of the HTTP request.
 */
export const AuditMeta = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext) =>
        extractRequestMeta(ctx.switchToHttp().getRequest<Request>()),
);

export function getChangedFields(
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
): string[] {
    const fields = new Set([
        ...Object.keys(before ?? {}),
        ...Object.keys(after ?? {}),
    ]);

    return [...fields].filter((field) => {
        const beforeValue = before?.[field] ?? null;
        const afterValue = after?.[field] ?? null;
        return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
    });
}

export function getChangedFieldsForKeys<T extends object>(
    before: T,
    after: T,
    keys: Array<keyof T>,
): string[] {
    return keys.filter((key) => {
        const beforeValue =
            (before as Record<string, unknown>)[key as string] ?? null;
        const afterValue =
            (after as Record<string, unknown>)[key as string] ?? null;
        return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
    }) as string[];
}
