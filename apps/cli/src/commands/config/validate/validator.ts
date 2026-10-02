import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
    CONFIG_FORMATS,
    CONFIG_RESOURCE_KINDS,
    CONFIG_SINGLETON_IDS,
    isConfigDocument,
    migrateDocument,
    schemaUrl,
    serializeDocument,
} from "@eudiplo/config-format/config-format.js";
import { validateConfigDocument } from "@eudiplo/config-format/config-validator.js";
import { resolveConfigVariables } from "@eudiplo/config-format/config-values.js";
import { CLI_VALIDATED_REGISTRY } from "./registry.js";
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
        .sort((left, right) => left.localeCompare(right));
}

export async function validateTenantsRoot(
    rootPath: string,
    schemas: Map<string, Record<string, unknown>>,
    env: NodeJS.ProcessEnv,
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
            ),
        );
    }
    return results;
}

export async function validateTenantDirectory(
    tenantPath: string,
    tenantId: string,
    schemas: Map<string, Record<string, unknown>>,
    env: NodeJS.ProcessEnv,
): Promise<TenantValidationResult> {
    if (!existsSync(tenantPath)) {
        throw new Error(`Tenant directory not found: ${tenantPath}`);
    }

    const state: TenantValidationState = {
        getValidator: createValidatorFactory(schemas),
        env,
        errors: [],
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

    return {
        id: tenantId,
        valid: state.errors.length === 0,
        files: state.files,
        errors: state.errors,
        resourceCounts: state.resourceCounts,
    };
}

interface TenantValidationState {
    getValidator: (schemaFile: string) => ValidateFunction;
    env: NodeJS.ProcessEnv;
    errors: ValidationIssue[];
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
        .sort((left, right) => left.name.localeCompare(right.name));

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
        state.getValidator,
        state.env,
        state.errors,
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
    getValidator: (schemaFile: string) => ValidateFunction,
    env: NodeJS.ProcessEnv,
    errors: ValidationIssue[],
): Promise<boolean> {
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
    } catch (error) {
        errors.push({
            file: relativeFile,
            message: `Invalid JSON: ${(error as Error).message}`,
        });
        return false;
    }

    const errorsBefore = errors.length;
    let resolved = resolvePlaceholders(payload, env, relativeFile, errors);
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
        const kind = CONFIG_RESOURCE_KINDS.find(
            (candidate) =>
                CONFIG_FORMATS[candidate].file ===
                schemaFile.replace(/\.schema\.json$/, ""),
        );
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
    env: NodeJS.ProcessEnv,
    file: string,
    errors: ValidationIssue[],
): unknown {
    const result = resolveConfigVariables(value, env);
    for (const issue of result.issues)
        errors.push({ file, path: issue.path, message: issue.message });
    return result.value;
}
