import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
    CONFIG_SINGLETON_IDS,
    type ConfigResourceKind,
    isConfigDocument,
    migrateDocument,
    normalizeDocument,
    RETIRED_TENANT_FOLDER_FILES,
    schemaUrl,
    serializeDocument,
} from "@eudiplo/config-format/config-format.js";
import { validateConfigDocument } from "@eudiplo/config-format/config-validator.js";
import { resolveConfigVariables } from "@eudiplo/config-format/config-values.js";
import { compareCodePoints } from "@eudiplo/config-format/tenant-folder.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { CLI_VALIDATED_REGISTRY, kindForSchemaFile } from "./registry.js";
import type {
    DirectoryResourceDefinition,
    FixedFileResourceDefinition,
    TenantValidationResult,
    ValidationIssue,
} from "./types.js";

async function discoverTenantDirectories(rootPath: string): Promise<string[]> {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareCodePoints);
}

export async function validateTenantsRoot(
    rootPath: string,
    schemas: Map<string, Record<string, unknown>>,
    env: NodeJS.ProcessEnv,
    options: TenantValidationOptions = {},
): Promise<TenantValidationResult[]> {
    if (!existsSync(rootPath)) {
        throw new Error(`Configuration root not found: ${rootPath}`);
    }

    const tenantIds = await discoverTenantDirectories(rootPath);
    const results: TenantValidationResult[] = [];
    for (const tenantId of tenantIds) {
        results.push(
            await validateTenantDirectory(
                join(rootPath, tenantId),
                tenantId,
                schemas,
                env,
                options,
            ),
        );
    }
    return results;
}

export interface TenantValidationOptions {
    /**
     * Report `${VAR}` placeholders without a value in `unresolved` instead of
     * as errors, and validate the file with the placeholder text in place.
     * `config plan`/`import` use this: the server reports them as
     * SECRET_REQUIRED, so a freshly exported folder can still be planned.
     */
    allowUnresolvedPlaceholders?: boolean;
    /**
     * Check the variables the placeholders name as the backend does when it
     * loads the folder from CONFIG_FOLDER ({@link checkFolderVariable}).
     * `config tenant validate` uses this; `config plan`/`import` do not,
     * because the CLI fills a folder sent to the API from `--allow-env`.
     */
    folderVariablePolicy?: boolean;
}

export async function validateTenantDirectory(
    tenantPath: string,
    tenantId: string,
    schemas: Map<string, Record<string, unknown>>,
    env: NodeJS.ProcessEnv,
    options: TenantValidationOptions = {},
): Promise<TenantValidationResult> {
    if (!existsSync(tenantPath)) {
        throw new Error(`Tenant directory not found: ${tenantPath}`);
    }

    const state: TenantValidationState = {
        getValidator: createValidatorFactory(schemas),
        env,
        errors: [],
        unresolved: [],
        warnings: [],
        allowUnresolvedPlaceholders: options.allowUnresolvedPlaceholders,
        folderVariablePolicy: options.folderVariablePolicy,
        resourceCounts: {},
        files: 0,
    };

    for (const entry of CLI_VALIDATED_REGISTRY) {
        if (entry.kind === "file") {
            await validateFixedFileEntry(tenantPath, entry, state);
        } else {
            await validateDirectoryEntry(tenantPath, entry, state);
        }
    }
    // Files of retired kinds are skipped on import, with this warning.
    const warnings: ValidationIssue[] = [
        ...RETIRED_TENANT_FOLDER_FILES.filter(({ file }) =>
            existsSync(join(tenantPath, file)),
        ).map(({ file, issue }) => ({ file, message: issue.message })),
        ...state.warnings,
    ];

    return {
        id: tenantId,
        valid: state.errors.length === 0,
        files: state.files,
        errors: state.errors,
        warnings,
        ...(options.allowUnresolvedPlaceholders
            ? { unresolved: state.unresolved }
            : {}),
        resourceCounts: state.resourceCounts,
    };
}

interface TenantValidationState {
    getValidator: (schemaFile: string) => ValidateFunction;
    env: NodeJS.ProcessEnv;
    errors: ValidationIssue[];
    unresolved: ValidationIssue[];
    warnings: ValidationIssue[];
    allowUnresolvedPlaceholders?: boolean;
    folderVariablePolicy?: boolean;
    resourceCounts: Record<string, number>;
    files: number;
}

function createValidatorFactory(
    schemas: Map<string, Record<string, unknown>>,
): (schemaFile: string) => ValidateFunction {
    const ajv = new Ajv2020Module.default({ allErrors: true, strict: false });
    addFormatsModule.default(
        ajv as Parameters<typeof addFormatsModule.default>[0],
    );
    for (const [schemaFile, schema] of schemas) {
        ajv.addSchema(schema, schemaFile);
    }
    const validators = new Map<string, ValidateFunction>();
    return (schemaFile: string): ValidateFunction => {
        const cached = validators.get(schemaFile);
        if (cached) {
            return cached;
        }
        const schema = schemas.get(schemaFile);
        if (!schema) {
            throw new Error(`No bundled schema found for "${schemaFile}".`);
        }
        const schemaId =
            typeof schema.$id === "string" ? schema.$id : undefined;
        const validator =
            (schemaId ? ajv.getSchema(schemaId) : undefined) ??
            ajv.compile(schema);
        validators.set(schemaFile, validator);
        return validator;
    };
}

async function validateFixedFileEntry(
    tenantPath: string,
    entry: FixedFileResourceDefinition,
    state: TenantValidationState,
): Promise<void> {
    const filePath = join(tenantPath, entry.file);
    if (!existsSync(filePath)) {
        if (entry.required) {
            state.errors.push({
                file: entry.file,
                message: `Missing required ${entry.resourceType} file`,
            });
        }
        return;
    }

    state.files += 1;
    await recordValidationOutcome(
        filePath,
        entry.file,
        entry.resourceType,
        entry.schemaFile,
        state,
    );
}

async function validateDirectoryEntry(
    tenantPath: string,
    entry: DirectoryResourceDefinition,
    state: TenantValidationState,
): Promise<void> {
    const directoryPath = join(tenantPath, entry.subfolder);
    if (!existsSync(directoryPath)) {
        return;
    }

    const dirEntries = (await readdir(directoryPath, { withFileTypes: true }))
        .filter(
            (dirEntry) => dirEntry.isFile() && dirEntry.name.endsWith(".json"),
        )
        .sort((left, right) => compareCodePoints(left.name, right.name));

    for (const dirEntry of dirEntries) {
        const relativeFile = `${entry.subfolder}/${dirEntry.name}`;
        const filePath = join(directoryPath, dirEntry.name);
        state.files += 1;
        await recordValidationOutcome(
            filePath,
            relativeFile,
            entry.resourceType,
            entry.schemaFile,
            state,
        );
    }
}

async function recordValidationOutcome(
    filePath: string,
    relativeFile: string,
    resourceType: string,
    schemaFile: string,
    state: TenantValidationState,
): Promise<void> {
    const isValid = await validateResourceFile(
        filePath,
        relativeFile,
        schemaFile,
        state,
    );
    if (isValid) {
        state.resourceCounts[resourceType] =
            (state.resourceCounts[resourceType] ?? 0) + 1;
    }
}

async function validateResourceFile(
    filePath: string,
    relativeFile: string,
    schemaFile: string,
    state: TenantValidationState,
): Promise<boolean> {
    const { errors, getValidator } = state;
    const kind = kindForSchemaFile(schemaFile);
    let raw: string;
    try {
        raw = await readFile(filePath, "utf8");
    } catch (error) {
        errors.push({
            file: relativeFile,
            message: `Failed to read file: ${(error as Error).message}`,
        });
        return false;
    }

    let payload: unknown;
    try {
        payload = JSON.parse(raw);
    } catch {
        // The parser's message can quote a secret from the file; do not repeat it.
        errors.push({ file: relativeFile, message: "Invalid JSON" });
        return false;
    }

    const errorsBefore = errors.length;
    let resolved = resolvePlaceholders(payload, relativeFile, kind, state);
    if (errors.length > errorsBefore) {
        return false;
    }

    if (isConfigDocument(resolved)) {
        try {
            const result = migrateDocument(resolved, validateConfigDocument);
            const blocking = result.issues.filter(
                (issue) => issue.severity !== "warning",
            );
            if (blocking.length) {
                for (const issue of blocking)
                    errors.push({
                        file: relativeFile,
                        path: issue.path,
                        message: issue.message,
                    });
                return false;
            }
            resolved = serializeDocument(result.document);
        } catch (error) {
            errors.push({
                file: relativeFile,
                message: (error as Error).message,
            });
            return false;
        }
    } else {
        if (
            kind &&
            resolved &&
            typeof resolved === "object" &&
            !Array.isArray(resolved)
        ) {
            const spec = structuredClone(resolved) as Record<string, unknown>;
            if (kind === "KeyChain" && spec.key && !spec.keySource) {
                spec.keySource = { type: "private-jwk", jwk: spec.key };
                delete spec.key;
            }
            if (!CONFIG_SINGLETON_IDS[kind])
                spec[kind === "Client" ? "clientId" : "id"] ??= basename(
                    relativeFile,
                    ".json",
                );
            resolved = {
                $schema: schemaUrl(kind),
                metadata: { generation: 1 },
                spec,
            };
            // Checked as the current version, so its rules beyond JSON Schema (one
            // display entry per locale) and readable display color messages apply too.
            if (kind === "CredentialConfig") {
                let issues: ReturnType<typeof validateConfigDocument>;
                try {
                    issues = validateConfigDocument(
                        normalizeDocument(resolved),
                    );
                } catch (error) {
                    errors.push({
                        file: relativeFile,
                        message: (error as Error).message,
                    });
                    return false;
                }
                for (const issue of issues)
                    errors.push({
                        file: relativeFile,
                        path: issue.path,
                        message: issue.message,
                    });
                if (issues.length) return false;
            }
        }
    }
    const validate = getValidator(schemaFile);
    if (!validate(resolved)) {
        for (const issue of validate.errors ?? []) {
            errors.push({
                file: relativeFile,
                path: formatErrorPath(issue),
                message: issue.message ?? "Invalid value",
            });
        }
        return false;
    }

    return true;
}

function formatErrorPath(issue: ErrorObject): string | undefined {
    const path = issue.instancePath.replace(/^\//, "").replaceAll("/", ".");
    if (path) {
        return path;
    }
    const missingProperty = (
        issue.params as { missingProperty?: string } | undefined
    )?.missingProperty;
    return missingProperty;
}

/**
 * Resolves ${VAR} / ${VAR:default} placeholders for schema validation without ever
 * emitting resolved secret values in error output; unresolved required placeholders
 * are reported by reference to their variable name only.
 */
function resolvePlaceholders(
    value: unknown,
    file: string,
    kind: ConfigResourceKind | undefined,
    state: TenantValidationState,
): unknown {
    const kms = kind === "KmsConfig";
    // The resolver reads a variable only for a placeholder it found, also one
    // with a default, so the check sees exactly the names the file uses.
    const named = new Set<string>();
    const env = new Proxy(state.env, {
        get: (target, name) => {
            if (typeof name !== "string") return undefined;
            named.add(name);
            return target[name];
        },
    });
    // A kms.json has no escaped form; the backend reads it the same way.
    const result = resolveConfigVariables(value, env, kms ? "none" : "resolve");
    const refused = new Set<string>();
    if (state.folderVariablePolicy)
        for (const variable of [...named].sort(compareCodePoints)) {
            const check = checkFolderVariable(variable, kms);
            if (check?.refused) {
                refused.add(variable);
                state.errors.push({ file, message: check.message, variable });
            } else if (check)
                state.warnings.push({ file, message: check.message, variable });
        }
    const placeholderIssues = state.allowUnresolvedPlaceholders
        ? state.unresolved
        : state.errors;
    // As in the backend, a refused variable is not also a missing one.
    for (const issue of result.issues)
        if (!refused.has(issue.variable))
            placeholderIssues.push({
                file,
                path: issue.path,
                message: issue.message,
                variable: issue.variable,
            });
    return result.value;
}

/**
 * Credentials the AWS SDK and the Azure identity library read from the
 * environment for the identity of the instance. The backend refuses them in
 * every file of a tenant folder other than `kms.json`
 * (`CLOUD_CREDENTIAL_VARIABLES` in
 * apps/backend/src/platform/config/config-variable-scope.ts; keep the two
 * lists equal).
 */
export const CLOUD_CREDENTIAL_VARIABLES: ReadonlyMap<string, string> = new Map([
    ["AWS_ACCESS_KEY_ID", "AWS"],
    ["AWS_SECRET_ACCESS_KEY", "AWS"],
    ["AWS_SESSION_TOKEN", "AWS"],
    ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS"],
    ["AZURE_CLIENT_SECRET", "Azure"],
    ["AZURE_CLIENT_CERTIFICATE_PASSWORD", "Azure"],
    ["AZURE_PASSWORD", "Azure"],
]);

/**
 * What the backend's variable policy says about `${variable}` in a file of a
 * tenant folder, as far as the CLI can tell without the instance:
 *
 * - The cloud credentials above are refused in every file but `kms.json`,
 *   with the backend's reason.
 * - A tenant `kms.json` resolves only the variables the instance lists in
 *   `KMS_TENANT_VARIABLES`, which the CLI cannot read: a warning names the
 *   rule for each variable, except `PUBLIC_URL`, which every file can use.
 *
 * The backend also refuses the variables that configure EUDIPLO itself
 * (its environment schema); the CLI does not have that list and does not
 * report them. Nor can it read the instance's secret policy: when that sets
 * `templates.tenant`, the backend refuses every variable it does not list,
 * also one the CLI reports nothing for, and resolves a cloud credential it
 * lists by name.
 */
function checkFolderVariable(
    variable: string,
    kms: boolean,
): { refused: boolean; message: string } | undefined {
    // `placeholder: "any"` in apps/backend/src/issuer/issuer-validation.schema.ts.
    if (variable === "PUBLIC_URL") return undefined;
    if (kms)
        return {
            refused: false,
            message: `\${${variable}} is resolved only if the instance lists ${variable} in KMS_TENANT_VARIABLES, which cannot name a setting of EUDIPLO itself`,
        };
    const provider = CLOUD_CREDENTIAL_VARIABLES.get(variable);
    if (provider)
        return {
            refused: true,
            message: `\${${variable}} holds the ${provider} credentials of the instance, which a file of a tenant folder cannot use`,
        };
    return undefined;
}
