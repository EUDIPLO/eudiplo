import type { errors } from "jose";

/**
 * An encrypted JWT from a wallet that cannot be accepted: malformed or
 * undecryptable JWE, an unsupported `alg` or `enc`, a payload that is not a
 * JWT claims set, or `nbf`/`exp` out of range. The sender is at fault, not
 * the server. The jose error is the `cause`.
 */
export class EncryptedResponseRejectedError extends Error {
    constructor(cause: errors.JOSEError) {
        super(cause.message, { cause });
        this.name = "EncryptedResponseRejectedError";
    }
}
