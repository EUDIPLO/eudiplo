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
import { NotSupportedError } from "./shared/domain/not-supported-error.js";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionsFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const isProduction = process.env.NODE_ENV === "production";
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();
        const requestPath = request.path || request.url.split("?")[0] || "/";

        const status = AllExceptionsFilter.statusOf(exception);
        const { message, responseBody } = AllExceptionsFilter.contentOf(
            exception,
            isProduction,
        );

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

    private static statusOf(exception: unknown): number {
        if (exception instanceof HttpException) {
            return exception.getStatus();
        }
        if (
            exception instanceof EntityNotFoundError ||
            exception instanceof NotFoundError
        ) {
            return HttpStatus.NOT_FOUND;
        }
        if (exception instanceof ConflictError) {
            return HttpStatus.CONFLICT;
        }
        if (exception instanceof NotSupportedError) {
            return HttpStatus.NOT_IMPLEMENTED;
        }
        return HttpStatus.INTERNAL_SERVER_ERROR;
    }

    /** The message, and the fields of an HTTP exception's own body. */
    private static contentOf(
        exception: unknown,
        isProduction: boolean,
    ): { message: unknown; responseBody?: Record<string, unknown> } {
        if (exception instanceof HttpException) {
            const httpResponse = exception.getResponse();
            if (
                httpResponse &&
                typeof httpResponse === "object" &&
                !Array.isArray(httpResponse)
            ) {
                const responseBody = httpResponse as Record<string, unknown>;
                return { message: responseBody.message, responseBody };
            }
            return { message: httpResponse };
        }
        if (exception instanceof NotSupportedError) {
            // The body of Nest's NotImplementedException, which /api/user
            // answered with before. The message names the setting behind it.
            return {
                message: exception.message,
                responseBody: { error: "Not Implemented" },
            };
        }
        // Conflict messages name the taken resource, never internals.
        if (
            exception instanceof Error &&
            (!isProduction || exception instanceof ConflictError)
        ) {
            return { message: exception.message };
        }
        return { message: "Internal Server Error" };
    }
}
