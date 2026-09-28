/**
 * Base class for transport-neutral "resource does not exist" errors raised by
 * application/domain code and repository adapters. The HTTP boundary
 * (`AllExceptionsFilter`) maps every subclass to 404, replacing the implicit
 * mapping previously provided by TypeORM's `EntityNotFoundError`.
 */
export abstract class NotFoundError extends Error {}
