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
} from "../all-exceptions.filter.js";
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
 * anything else with "Internal server error".
 */
export function toMcpHttpException(error: ApplicationError): HttpException {
    if (error instanceof ValidationError) {
        return new BadRequestException(VALIDATION_FAILED);
    }
    return new HttpException(
        applicationErrorMessage(error),
        applicationErrorStatus(error) ?? 500,
    );
}

/** Applied to every `@McpTools()` provider. */
@Catch(NotFoundError, EntityNotFoundError, ConflictError, ValidationError)
export class McpErrorFilter implements ExceptionFilter {
    catch(error: ApplicationError): never {
        // Thrown, the HTTP exception goes on to the MCP module.
        throw toMcpHttpException(error);
    }
}
