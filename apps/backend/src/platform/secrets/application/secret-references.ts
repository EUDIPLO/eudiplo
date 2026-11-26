import { parseSecretReference } from "@eudiplo/config-format/config-values.js";
import type { SecretUse } from "../domain/secret-use.js";
import { SecretValue } from "../domain/secret-value.js";
import type { SecretResolver } from "./secret-resolver.js";

export const SECRET_REFERENCES = Symbol("SECRET_REFERENCES");

/**
 * The values of secret fields, which may be secret references such as
 * `${vault:kv/eudiplo/acme/shop#token}`.
 *
 * References are only read while the operator sets a secret policy
 * (`SECRET_POLICY_FILE`). Without one, every value is a literal, as before,
 * also text that looks like a reference.
 */
export class SecretReferences {
    constructor(private readonly resolver?: SecretResolver) {}

    /** Whether a secret policy is set. */
    get enabled(): boolean {
        return this.resolver !== undefined;
    }

    /**
     * Whether `value` is read as a reference: while a policy is set, every
     * value of the form `${<source>:…}`, also a malformed one, which
     * {@link assertAllowed} then refuses instead of storing it as a literal.
     */
    isReference(value: string): boolean {
        return this.enabled && parseSecretReference(value) !== undefined;
    }

    /**
     * Whether `value` may be shown in a response or audit entry: only a
     * well-formed reference while a policy is set. Anything else, also text
     * that only looks like a reference, may be a literal secret.
     */
    isShown(value: string): boolean {
        return this.enabled && parseSecretReference(value)?.ok === true;
    }

    /**
     * Checks a value before it is stored, without reading it. A literal
     * passes.
     *
     * @throws SecretReferenceInvalidError when it is a malformed reference
     * @throws SecretReferenceRefusedError when the policy refuses it for `use`
     */
    assertAllowed(value: string, use: SecretUse): void {
        if (this.resolver && this.isReference(value))
            this.resolver.check(value, use);
    }

    /**
     * The value to use: a reference resolved under the policy, a literal as
     * it is.
     *
     * @throws what {@link SecretResolver.resolve} throws, for a reference
     */
    valueOf(value: string, use: SecretUse): Promise<SecretValue> {
        return this.resolver && this.isReference(value)
            ? this.resolver.resolve(value, use)
            : Promise.resolve(new SecretValue(value));
    }
}
