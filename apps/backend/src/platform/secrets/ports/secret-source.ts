import type { SecretReference } from "@eudiplo/config-format/config-values.js";
import type { SecretScope } from "../domain/secret-use.js";
import type { SecretValue } from "../domain/secret-value.js";

/** The source types an adapter can implement; `required` never resolves. */
export type SecretSourceType = Exclude<SecretReference["source"], "required">;

/**
 * Where secrets of one reference type (`${env:…}`, `${vault:…}`) are read.
 *
 * Everything except {@link read} is pure: the policy uses it to decide, from
 * the operator's grants, which references a scope may name. A grant pattern
 * describes a set of references; a source with {@link tenantTemplates} also
 * accepts the text before `{tenant}` of a pattern as a pattern, the set that
 * holds the namespaces of all tenants.
 */
export interface SecretSource {
    readonly type: SecretSourceType;

    /** Whether grants of this source may name `{tenant}`. */
    readonly tenantTemplates: boolean;

    /**
     * Why `pattern` is no grant of this source for a scope of `scopeType`,
     * or undefined when it is one. With {@link tenantTemplates}, `pattern`
     * may hold `{tenant}`; the source decides where it may stand.
     */
    validatePattern(
        pattern: string,
        scopeType: SecretScope["type"],
    ): string | undefined;

    /** Whether `reference` lies inside the grant `pattern`. */
    within(
        reference: SecretReference,
        pattern: string,
        scopeType: SecretScope["type"],
    ): boolean;

    /** Whether one reference can lie inside both patterns. */
    overlaps(pattern: string, other: string): boolean;

    /** Whether every reference inside `inner` lies inside `outer`. */
    contains(outer: string, inner: string): boolean;

    /**
     * Why no grant can let a scope of `scopeType` name `reference`, such as a
     * setting of EUDIPLO itself, or undefined.
     */
    refusal(
        reference: SecretReference,
        scopeType: SecretScope["type"],
    ): string | undefined;

    /**
     * The value, or undefined when the source answered that it has none,
     * also when it refuses this one reference (no permission for the path).
     *
     * @throws only when the source cannot be asked at all (unreachable, its
     * own credentials rejected). The resolver then serves a cached value for
     * a while and does not ask again for this reference during a cooldown.
     * It also stops waiting after its timeout, whether or not the read
     * honours `signal`.
     */
    read(
        reference: SecretReference,
        signal: AbortSignal,
    ): Promise<SecretValue | undefined>;
}
