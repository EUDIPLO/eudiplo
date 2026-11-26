/*
 * Errors of secret resolution. Their messages name the reference, which is
 * no secret, and never a value.
 */

/** A value that should be a secret reference is none, or is malformed. */
export class SecretReferenceInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SecretReferenceInvalidError";
    }
}

/** The operator's policy does not let this use name the reference. */
export class SecretReferenceRefusedError extends Error {
    constructor(
        readonly reference: string,
        reason: string,
    ) {
        super(`${reference} is refused: ${reason}`);
        this.name = "SecretReferenceRefusedError";
    }
}

/** The source answered, and holds no value for the reference. */
export class SecretMissingError extends Error {
    constructor(readonly reference: string) {
        super(`${reference} has no value in its source`);
        this.name = "SecretMissingError";
    }
}

/** The source did not answer, and no value of it may be used any longer. */
export class SecretUnavailableError extends Error {
    constructor(
        readonly reference: string,
        options?: { cause?: unknown },
    ) {
        super(
            `${reference} cannot be read: its source is unavailable`,
            options,
        );
        this.name = "SecretUnavailableError";
    }
}

/** The operator's secret policy is not valid. */
export class SecretPolicyError extends Error {
    constructor(readonly issues: string[]) {
        super(`Invalid secret policy: ${issues.join("; ")}`);
        this.name = "SecretPolicyError";
    }
}
