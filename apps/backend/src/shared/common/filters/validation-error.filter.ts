import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpStatus,
    Logger,
} from "@nestjs/common";
import { ValidationError } from "@owf/identity-common";
import { Response } from "express";

/**
 * Global exception filter for the ValidationError of @owf/identity-common,
 * which the @openid4vc packages throw for a request that does not validate.
 * It answers 400 with the issues of the request.
 *
 * Its subclasses, such as JoseValidationError for a JWT that does not
 * validate, also answer 400, as such errors did before the libraries moved
 * to @owf/jose, but without their issues: those can carry the expected value
 * of a claim, which the caller does not need. The log has them.
 */
@Catch(ValidationError)
export class ValidationErrorFilter implements ExceptionFilter {
    private readonly logger = new Logger(ValidationErrorFilter.name);

    catch(exception: ValidationError, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();

        const issues = exception.issues;
        const ofRequest = exception.constructor === ValidationError;

        // Log with full details (no [Array] truncation)
        const kind = ofRequest ? "" : ` (${exception.name})`;
        this.logger.error(
            `Validation error${kind}: ${JSON.stringify(issues, null, 2)}`,
        );

        response.status(HttpStatus.BAD_REQUEST).json({
            statusCode: HttpStatus.BAD_REQUEST,
            message: "Validation failed",
            ...(ofRequest && { errors: issues }),
            timestamp: new Date().toISOString(),
        });
    }
}
