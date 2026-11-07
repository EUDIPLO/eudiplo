/**
 * Base class for transport-neutral "this instance does not offer it" errors,
 * such as managing clients that the identity provider manages. The HTTP
 * boundary (`AllExceptionsFilter`) maps every subclass to 501 and keeps the
 * message, which names the setting behind it.
 */
export abstract class NotSupportedError extends Error {}
