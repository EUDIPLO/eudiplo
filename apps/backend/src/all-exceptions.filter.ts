import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { redactUrlPath } from "./platform/observability/redact-url.js";
import {
    applicationErrorMessage,
    applicationErrorStatus,
} from "./shared/common/filters/application-errors.js";

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
