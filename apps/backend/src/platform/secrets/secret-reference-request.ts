import { BadRequestException } from "@nestjs/common";
import type { SecretReferences } from "./application/secret-references.js";
import {
    SecretReferenceInvalidError,
    SecretReferenceRefusedError,
} from "./domain/secret-errors.js";
import type { SecretUse } from "./domain/secret-use.js";

/**
 * Checks the value of a secret field before it is stored, for the services
 * that store it: a secret reference must be one the policy lets `use`
 * name. A literal passes.
 *
 * @throws BadRequestException naming `path` and why the reference is refused
 * or malformed
 */
export function assertSecretFieldAllowed(
    secrets: SecretReferences,
    value: string,
    use: SecretUse,
    path: string,
): void {
    try {
        secrets.assertAllowed(value, use);
    } catch (error) {
        if (
            error instanceof SecretReferenceRefusedError ||
            error instanceof SecretReferenceInvalidError
        )
            throw new BadRequestException(`${path}: ${error.message}`);
        throw error;
    }
}
