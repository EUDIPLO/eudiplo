import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpStatus,
    Logger,
} from "@nestjs/common";
import { ValidationError } from "@openid4vc/utils";
import { Response } from "express";

/** The message of a validation error, without its issues outside HTTP. */
export const VALIDATION_FAILED = "Validation failed";

/**
 * Global exception filter for handling ValidationError from @openid4vc/utils.
 * Catches all ValidationError instances, formats them consistently, and returns proper HTTP responses.
 */
@Catch(ValidationError)
export class ValidationErrorFilter implements ExceptionFilter {
    private readonly logger = new Logger(ValidationErrorFilter.name);

    catch(exception: ValidationError, host: ArgumentsHost) {
        // Not an HTTP request, for example an MCP tool call: let its own
        // error handling answer.
        if (host.getType() !== "http") {
            return;
        }
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();

        // Format Zod validation errors for better readability
        const issues = exception.zodError?.issues;

        // Log with full details (no [Array] truncation)
        this.logger.error(
            `Validation error: ${JSON.stringify(issues, null, 2)}`,
        );

        // Return formatted error response
        response.status(HttpStatus.BAD_REQUEST).json({
            statusCode: HttpStatus.BAD_REQUEST,
            message: VALIDATION_FAILED,
            errors: issues,
            timestamp: new Date().toISOString(),
        });
    }
}
