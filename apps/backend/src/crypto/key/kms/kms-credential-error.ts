/**
 * The credentials of a KMS provider are secret references that cannot be
 * used now. The message names the provider only: neither the reference nor
 * the operator's policy, which the log keeps.
 *
 * - `refused`: the secret policy refuses a reference, it is malformed, or
 *   its source holds no value. The stored configuration has to change.
 * - `unavailable`: the source of a reference does not answer and no cached
 *   value may be used any longer. A later attempt may succeed.
 *
 * For a provider of the global `kms.json` (`operatorsProvider`), tenants
 * learn neither: the message and {@link kind} say only that the credentials
 * cannot be read, which the operator has to fix.
 */
export class KmsCredentialError extends Error {
    readonly kind: "refused" | "unavailable";

    constructor(
        readonly providerId: string,
        kind: "refused" | "unavailable",
        options?: { cause?: unknown; operatorsProvider?: boolean },
    ) {
        const shown = options?.operatorsProvider ? "unavailable" : kind;
        super(
            options?.operatorsProvider
                ? `The credentials of KMS provider '${providerId}' cannot be read. The operator's log names the reason.`
                : shown === "refused"
                  ? `The credentials of KMS provider '${providerId}' cannot be used: the secret policy refuses a secret reference of them, or one is malformed or has no value. Fix the provider's configuration; the backend's log names the reference.`
                  : `The credentials of KMS provider '${providerId}' cannot be read: the source of a secret reference does not answer. Try again later.`,
            { cause: options?.cause },
        );
        this.kind = shown;
        this.name = "KmsCredentialError";
    }
}
