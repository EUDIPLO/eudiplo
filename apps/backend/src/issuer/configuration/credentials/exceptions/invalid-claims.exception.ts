import { ConflictException } from "@nestjs/common";

/**
 * Thrown when resolved claims do not match the credential configuration.
 * The message only contains claim paths, never claim values.
 */
export class InvalidClaimsException extends ConflictException {}
