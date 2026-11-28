import {
    type ArgumentsHost,
    Catch,
    ConflictException,
    type ExceptionFilter,
    ServiceUnavailableException,
} from "@nestjs/common";
import { AllExceptionsFilter } from "../../all-exceptions.filter.js";
import { KmsCredentialError } from "./kms/kms-credential-error.js";

/**
 * For the key chain API: a KMS provider whose credentials are secret
 * references that cannot be used answers `409` (the configuration must
 * change) or `503` (the secret source does not answer), with a message that
 * names the provider only. Elsewhere it stays a server error: where a
 * wallet's request needs a signature, and in management paths that report
 * failures their own way, such as a configuration bundle import
 * (`CONFIG_APPLY_FAILED`), whose log then has the provider-only message.
 */
@Catch(KmsCredentialError)
export class KmsCredentialErrorFilter implements ExceptionFilter {
    private readonly responses = new AllExceptionsFilter();

    catch(error: KmsCredentialError, host: ArgumentsHost): void {
        this.responses.catch(
            error.kind === "refused"
                ? new ConflictException(error.message, { cause: error })
                : new ServiceUnavailableException(error.message, {
                      cause: error,
                  }),
            host,
        );
    }
}
