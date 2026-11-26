const HIDDEN = "[secret]";

/**
 * A resolved secret. It prints as `[secret]` wherever it is turned into
 * text: in JSON (API responses, audit entries, pino logs), in
 * `util.inspect` (console, error output) and in string templates. Only
 * {@link reveal} gives the value, and only the code that sends it (a header,
 * a token request, a KMS adapter) calls it.
 */
export class SecretValue {
    readonly #value: string;

    constructor(value: string) {
        this.#value = value;
    }

    /** The value, for the one place that sends it. Never log or store it. */
    reveal(): string {
        return this.#value;
    }

    toString(): string {
        return HIDDEN;
    }

    toJSON(): string {
        return HIDDEN;
    }

    [Symbol.for("nodejs.util.inspect.custom")](): string {
        return HIDDEN;
    }
}
