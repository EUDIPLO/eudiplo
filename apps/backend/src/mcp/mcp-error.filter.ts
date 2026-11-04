import {
    BadRequestException,
    Catch,
    ConflictException,
    type ExceptionFilter,
    type HttpException,
    NotFoundException,
} from "@nestjs/common";
import { ValidationError } from "@openid4vc/utils";
import { EntityNotFoundError } from "typeorm";
import { ConflictError } from "../shared/domain/conflict-error.js";
import { NotFoundError } from "../shared/domain/not-found-error.js";

/**
 * The application errors that AllExceptionsFilter and ValidationErrorFilter
 * map for HTTP, as HTTP exceptions for MCP tool calls: @nestjs/mcp passes on
 * only the message of an HttpException and answers anything else with
 * "Internal server error". Messages follow the REST rules: a conflict keeps
 * its message, a missing resource only outside production.
 */
export function toMcpHttpException(
    error:
        | NotFoundError
        | EntityNotFoundError
        | ConflictError
        | ValidationError,
): HttpException {
    if (error instanceof ConflictError) {
        return new ConflictException(error.message);
    }
    if (error instanceof ValidationError) {
        return new BadRequestException("Validation failed");
    }
    return process.env.NODE_ENV === "production"
        ? new NotFoundException()
        : new NotFoundException(error.message);
}

/** Applied to every `@McpTools()` provider. */
@Catch(NotFoundError, EntityNotFoundError, ConflictError, ValidationError)
export class McpErrorFilter implements ExceptionFilter {
    catch(
        error:
            | NotFoundError
            | EntityNotFoundError
            | ConflictError
            | ValidationError,
    ): never {
        // Thrown, the HTTP exception goes on to the MCP module.
        throw toMcpHttpException(error);
    }
}
