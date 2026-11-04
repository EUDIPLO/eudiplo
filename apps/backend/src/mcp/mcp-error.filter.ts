import {
    BadRequestException,
    Catch,
    type ExceptionFilter,
    HttpException,
} from "@nestjs/common";
import { ValidationError } from "@openid4vc/utils";
import { EntityNotFoundError } from "typeorm";
import {
    applicationErrorMessage,
    applicationErrorStatus,
} from "../shared/common/filters/application-errors.js";
import { ConflictError } from "../shared/domain/conflict-error.js";
import { NotFoundError } from "../shared/domain/not-found-error.js";
import { VALIDATION_FAILED } from "../shared/common/filters/validation-error.filter.js";

type ApplicationError =
    | NotFoundError
    | EntityNotFoundError
    | ConflictError
    | ValidationError;

/**
 * An application error as the HTTP exception the management API answers
 * with (AllExceptionsFilter, ValidationErrorFilter), for MCP tool calls:
 * @nestjs/mcp passes on only the message of an HttpException and answers
 * anything else with "Internal server error". The status and the messages
 * are the REST API's, except a production 404 (see below).
 */
export function toMcpHttpException(error: ApplicationError): HttpException {
    if (error instanceof ValidationError) {
        return new BadRequestException(VALIDATION_FAILED);
    }
    const isProduction = process.env.NODE_ENV === "production";
    // Every error of the union has a status of its own.
    const status = applicationErrorStatus(error) ?? 500;
    // An MCP client gets the message, not the status: where the REST API
    // hides the message of a missing resource behind its 404, say "Not Found".
    const message =
        status === 404 && isProduction
            ? "Not Found"
            : applicationErrorMessage(error, isProduction);
    return new HttpException(message, status);
}

/** Applied to every `@McpTools()` provider. */
@Catch(NotFoundError, EntityNotFoundError, ConflictError, ValidationError)
export class McpErrorFilter implements ExceptionFilter {
    catch(error: ApplicationError): never {
        // Thrown, the HTTP exception goes on to the MCP module.
        throw toMcpHttpException(error);
    }
}
