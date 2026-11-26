import type { SecretReference } from "@eudiplo/config-format/config-values.js";
import {
    type PlaceholderScope,
    settingRefusal,
} from "../../config/config-variable-scope.js";
import type { SecretScope } from "../domain/secret-use.js";
import { SecretValue } from "../domain/secret-value.js";
import type { SecretSource } from "../ports/secret-source.js";

/** A variable name, or a prefix of names ending in `*`. */
const ENV_PATTERN = /^[A-Z0-9_]*\*$|^[A-Z0-9_]+$/;

const isPrefix = (pattern: string) => pattern.endsWith("*");
const prefixOf = (pattern: string) =>
    isPrefix(pattern) ? pattern.slice(0, -1) : pattern;

/**
 * `${env:NAME}`: a variable of the backend's process environment.
 *
 * A grant is a name (`SHOP_TOKEN`) or a prefix (`ACME_*`); only the instance
 * may have the prefix `*` alone, which covers variables the platform injects
 * (Kubernetes service links, sidecar tokens). Settings of EUDIPLO itself are
 * refused as for the `${VAR}` placeholders of configuration files
 * ({@link settingRefusal}). A prefix never covers a setting of EUDIPLO, nor
 * for a tenant the cloud credentials of the instance; the operator can only
 * grant those by name, as `KMS_TENANT_VARIABLES` does today.
 */
export class EnvSecretSource implements SecretSource {
    readonly type = "env";
    readonly tenantTemplates = false;

    constructor(
        private readonly env: Readonly<Record<string, string | undefined>>,
        private readonly declared: ReadonlyMap<string, PlaceholderScope>,
        private readonly cloudCredentials: ReadonlyMap<string, string>,
    ) {}

    validatePattern(
        pattern: string,
        scopeType: SecretScope["type"],
    ): string | undefined {
        if (!ENV_PATTERN.test(pattern))
            return "an env grant is a variable name of A-Z, 0-9 and _, or a prefix of one ending in *";
        if (pattern === "*" && scopeType === "tenant")
            return "a tenant cannot be granted every variable; name a prefix";
        if (isPrefix(pattern)) return undefined;
        return this.refusedName(pattern, scopeType);
    }

    within(
        reference: SecretReference,
        pattern: string,
        scopeType: SecretScope["type"],
    ): boolean {
        if (reference.source !== "env") return false;
        const name = reference.variable;
        if (!isPrefix(pattern)) return name === pattern;
        return (
            name.startsWith(prefixOf(pattern)) &&
            !this.declared.has(name) &&
            !(scopeType === "tenant" && this.cloudCredentials.has(name))
        );
    }

    overlaps(pattern: string, other: string): boolean {
        return this.contains(pattern, other) || this.contains(other, pattern);
    }

    contains(outer: string, inner: string): boolean {
        if (!isPrefix(outer)) return outer === inner;
        return prefixOf(inner).startsWith(prefixOf(outer));
    }

    refusal(
        reference: SecretReference,
        scopeType: SecretScope["type"],
    ): string | undefined {
        return reference.source === "env"
            ? this.refusedName(reference.variable, scopeType)
            : undefined;
    }

    read(reference: SecretReference): Promise<SecretValue | undefined> {
        if (reference.source !== "env") return Promise.resolve(undefined);
        const value = this.env[reference.variable];
        // An empty variable counts as unset, as for ${VAR} placeholders.
        return Promise.resolve(
            value === undefined || value === ""
                ? undefined
                : new SecretValue(value),
        );
    }

    private refusedName(
        name: string,
        scopeType: SecretScope["type"],
    ): string | undefined {
        switch (
            settingRefusal(this.declared.get(name), scopeType === "instance")
        ) {
            case "never":
                return `${name} is a setting of EUDIPLO itself, which no reference can name`;
            case "instance-only":
                return `${name} is a setting of EUDIPLO itself, which only the instance can name`;
            default:
                return undefined;
        }
    }
}
