import type Joi from "joi";
import { VALIDATION_SCHEMA } from "./combined.schema.js";

/**
 * Where a configuration file with `${VAR}` placeholders lives:
 *
 * - `global`: written by the operator for the whole instance (the global
 *   `kms.json`).
 * - `tenant`: a file of a tenant's configuration folder.
 * - `tenant-kms`: the tenant's `kms.json`, the one tenant file the API writes.
 */
export type ConfigFileScope = "global" | "tenant" | "tenant-kms";

/**
 * Which configuration files may name a variable EUDIPLO declares, set as
 * `.meta({ placeholder })` in its validation schema:
 *
 * - `none` (default): no file. The variable configures EUDIPLO itself.
 * - `global`: global files only.
 * - `any`: every file.
 */
export type PlaceholderScope = "none" | "global" | "any";

const PLACEHOLDER_SCOPES: readonly PlaceholderScope[] = [
    "none",
    "global",
    "any",
];

const VARIABLE_NAME = /^[A-Z0-9_]+$/;

/** Name of the setting that lists the variables a tenant `kms.json` may use. */
export const KMS_TENANT_VARIABLES = "KMS_TENANT_VARIABLES";

/**
 * Credentials the AWS SDK and the Azure identity library read from the
 * environment for the identity of the instance, with the provider's name.
 * EUDIPLO declares none of them, so the schema does not refuse them. A file
 * of a tenant folder cannot name them; the global `kms.json` can, and a
 * tenant `kms.json` only if the operator lists them.
 */
const CLOUD_CREDENTIAL_VARIABLES: ReadonlyMap<string, string> = new Map([
    ["AWS_ACCESS_KEY_ID", "AWS"],
    ["AWS_SECRET_ACCESS_KEY", "AWS"],
    ["AWS_SESSION_TOKEN", "AWS"],
    ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS"],
    ["AZURE_CLIENT_SECRET", "Azure"],
    ["AZURE_CLIENT_CERTIFICATE_PASSWORD", "Azure"],
    ["AZURE_PASSWORD", "Azure"],
]);

/** The placeholder scope of every variable `schema` declares. */
export function declaredPlaceholderScopes(
    schema: Joi.ObjectSchema,
): Map<string, PlaceholderScope> {
    const keys: Record<string, { metas?: Record<string, unknown>[] }> =
        (schema.describe() as any).keys ?? {};
    return new Map(
        Object.entries(keys).map(([name, description]) => {
            const scope = Object.assign(
                {},
                ...(description.metas ?? []),
            ).placeholder;
            if (scope !== undefined && !PLACEHOLDER_SCOPES.includes(scope)) {
                throw new Error(
                    `${name}: unknown placeholder scope '${String(scope)}'`,
                );
            }
            return [name, (scope as PlaceholderScope) ?? "none"];
        }),
    );
}

let declared: Map<string, PlaceholderScope> | undefined;

function declaredScopes(): Map<string, PlaceholderScope> {
    declared ??= declaredPlaceholderScopes(VALIDATION_SCHEMA);
    return declared;
}

/**
 * Why a file of `scope` may not use the environment variable `name` as a
 * `${NAME}` placeholder, or undefined when it may.
 *
 * Variables EUDIPLO declares follow their {@link PlaceholderScope}. Other
 * variables are the operator's own: every file may use them, except a tenant
 * `kms.json`, which needs them listed in `tenantKmsVariables`, and except
 * {@link CLOUD_CREDENTIAL_VARIABLES} in the other files of a tenant folder.
 */
export function refusedConfigVariable(
    name: string,
    scope: ConfigFileScope,
    tenantKmsVariables: ReadonlySet<string> = new Set(),
): string | undefined {
    const declaredScope = declaredScopes().get(name);
    if (declaredScope === "any") return undefined;
    if (declaredScope === "none") {
        return `\${${name}} names a setting of EUDIPLO itself, which no configuration file can use`;
    }
    if (declaredScope === "global") {
        return scope === "global"
            ? undefined
            : `\${${name}} names a setting of EUDIPLO itself, which only the global kms.json can use`;
    }
    const provider = CLOUD_CREDENTIAL_VARIABLES.get(name);
    if (scope === "tenant" && provider) {
        return `\${${name}} holds the ${provider} credentials of the instance, which a file of a tenant folder cannot use`;
    }
    if (scope === "tenant-kms" && !tenantKmsVariables.has(name)) {
        return `\${${name}} is not listed in ${KMS_TENANT_VARIABLES}, so a tenant kms.json cannot use it`;
    }
    return undefined;
}

/**
 * The variable names of a `KMS_TENANT_VARIABLES` value (comma-separated).
 *
 * @throws when an entry is no variable name, or names a variable EUDIPLO
 * declares: listing it would not make it usable.
 */
export function parseTenantKmsVariables(value: unknown): Set<string> {
    const names = String(value ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    for (const name of names) {
        if (!VARIABLE_NAME.test(name)) {
            throw new Error(
                `${KMS_TENANT_VARIABLES}: '${name}' is not a variable name (A-Z, 0-9 and _)`,
            );
        }
        const declaredScope = declaredScopes().get(name);
        if (declaredScope !== undefined && declaredScope !== "any") {
            throw new Error(
                `${KMS_TENANT_VARIABLES}: ${name} is a setting of EUDIPLO itself and cannot be made available to tenant kms.json files`,
            );
        }
    }
    return new Set(names);
}
