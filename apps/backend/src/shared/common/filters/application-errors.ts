import { HttpStatus } from "@nestjs/common";
import { EntityNotFoundError } from "typeorm";
import { ConflictError } from "../../domain/conflict-error.js";
import { NotFoundError } from "../../domain/not-found-error.js";

/**
 * The status of the application errors the API maps itself, for HTTP in
 * AllExceptionsFilter and for MCP tool calls in McpErrorFilter; `undefined`
 * for others.
 */
export function applicationErrorStatus(exception: unknown): number | undefined {
    if (
        exception instanceof EntityNotFoundError ||
        exception instanceof NotFoundError
    ) {
        return HttpStatus.NOT_FOUND;
    }
    if (exception instanceof ConflictError) {
        return HttpStatus.CONFLICT;
    }
    return undefined;
}

/**
 * The message of an error that is not an `HttpException`: only outside
 * production, except for conflicts, whose messages name the taken resource,
 * never internals.
 */
export function applicationErrorMessage(
    exception: unknown,
    isProduction: boolean,
): string {
    return exception instanceof Error &&
        (!isProduction || exception instanceof ConflictError)
        ? exception.message
        : "Internal Server Error";
}
