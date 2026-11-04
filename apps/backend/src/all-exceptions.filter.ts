import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { EntityNotFoundError } from "typeorm";
import { redactUrlPath } from "./platform/observability/redact-url.js";
import { ConflictError } from "./shared/domain/conflict-error.js";
import { NotFoundError } from "./shared/domain/not-found-error.js";

/**
 * The status of the application errors the API maps itself, for HTTP here
 * and for MCP tool calls in `mcp-error.filter.ts`; `undefined` for others.
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
    isProduction = process.env.NODE_ENV === "production",
): string {
    return exception instanceof Error &&
        (!isProduction || exception instanceof ConflictError)
        ? exception.message
        : "Internal Server Error";
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionsFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        // An MCP tool call has no HTTP response to write. Returning nothing
        // hands the exception back to the MCP module, which answers the call.
        if (host.getType() !== "http") {
            return;
        }
        const isProduction = process.env.NODE_ENV === "production";
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();
        const requestPath = request.path || request.url.split("?")[0] || "/";

        const status =
            exception instanceof HttpException
                ? exception.getStatus()
                : (applicationErrorStatus(exception) ??
                  HttpStatus.INTERNAL_SERVER_ERROR);

        let message: unknown;
        let responseBody: Record<string, unknown> | undefined;
        if (exception instanceof HttpException) {
            const httpResponse = exception.getResponse();
            if (typeof httpResponse === "string") {
                message = httpResponse;
            } else if (
                httpResponse &&
                typeof httpResponse === "object" &&
                !Array.isArray(httpResponse)
            ) {
                responseBody = httpResponse as Record<string, unknown>;
                message = responseBody.message;
            } else {
                message = httpResponse;
            }
        } else {
            message = applicationErrorMessage(exception, isProduction);
        }

        // OAuth error responses (RFC 6749 Section 5.2) carry `error` and
        // `error_description` instead of `message`.
        const logMessage =
            message ?? responseBody?.error_description ?? responseBody?.error;

        // Log the error with stack trace if available using NestJS Logger
        this.logger.error(
            `[${request.method}] ${redactUrlPath(requestPath)} ${status} - ${JSON.stringify(logMessage)}`,
            exception instanceof Error ? exception.stack : undefined,
        );

        response.status(status).json({
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: requestPath,
            ...(responseBody ?? {}),
            message,
        });
    }
}
