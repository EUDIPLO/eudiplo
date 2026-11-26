import {
    parseSecretReference,
    type SecretReference,
} from "@eudiplo/config-format/config-values.js";
import {
    CLOUD_CREDENTIAL_VARIABLES,
    declaredScopes,
} from "../../src/platform/config/config-variable-scope.js";
import { EnvSecretSource } from "../../src/platform/secrets/adapters/env-secret-source.js";
import { SecretValue } from "../../src/platform/secrets/domain/secret-value.js";
import type { SecretSource } from "../../src/platform/secrets/ports/secret-source.js";

/** Test helper: the parsed form of a reference that must be valid. */
export function reference(text: string): SecretReference {
    const parsed = parseSecretReference(text);
    if (!parsed?.ok) throw new Error(`no valid reference: ${text}`);
    return parsed.reference;
}

const vaultKey = (ref: SecretReference) =>
    ref.source === "vault" ? `${ref.mount}/${ref.path}#${ref.field}` : "";

/**
 * Test helper: a vault-like source with `{tenant}` namespaces, whose
 * grants are path prefixes ending in `/` or exact `<mount>/<path>#<key>`.
 */
export class StubVaultSource implements SecretSource {
    readonly type = "vault";
    readonly tenantTemplates = true;
    values = new Map<string, string>();
    /** References whose read throws, or `all`. */
    failing: Set<string> | "all" | false = false;
    /** Reads never settle and ignore their signal. */
    hanging = false;
    reads = 0;
    lastSignal?: AbortSignal;

    /** The patterns the policy asked about, as written. */
    validated: string[] = [];

    validatePattern(pattern: string): string | undefined {
        this.validated.push(pattern);
        if (pattern.includes("refused")) return "the stub refuses it";
        return /^[a-z]+\/(?:[A-Za-z0-9/_#-]|\{tenant\})+$/.test(pattern)
            ? undefined
            : "not a vault grant";
    }

    within(ref: SecretReference, pattern: string): boolean {
        const key = vaultKey(ref);
        return pattern.endsWith("/")
            ? key.startsWith(pattern)
            : key === pattern;
    }

    overlaps(pattern: string, other: string): boolean {
        return pattern.startsWith(other) || other.startsWith(pattern);
    }

    contains(outer: string, inner: string): boolean {
        return outer.endsWith("/") ? inner.startsWith(outer) : outer === inner;
    }

    refusal(): string | undefined {
        return undefined;
    }

    async read(
        ref: SecretReference,
        signal: AbortSignal,
    ): Promise<SecretValue | undefined> {
        this.reads++;
        this.lastSignal = signal;
        if (this.hanging) return new Promise(() => {});
        if (
            this.failing === "all" ||
            (this.failing && this.failing.has(vaultKey(ref)))
        )
            throw new Error("vault is down");
        const value = this.values.get(vaultKey(ref));
        return value === undefined ? undefined : new SecretValue(value);
    }
}

/** Test helper: the env source over a fixed environment. */
export const envSource = (environment: Record<string, string>) =>
    new EnvSecretSource(
        environment,
        declaredScopes(),
        CLOUD_CREDENTIAL_VARIABLES,
    );
