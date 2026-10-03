import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
    assertContextName,
    assertNamespace,
    assertWorkloadReference,
} from "./kubectl.js";
import type { CliConfig, InstanceConfig } from "../types.js";

const emptyConfig = (): CliConfig => ({ instances: {} });

export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
    if (env.EUDIPLO_CLI_CONFIG) {
        return resolve(env.EUDIPLO_CLI_CONFIG);
    }

    const baseDir = env.EUDIPLO_CLI_HOME
        ? resolve(env.EUDIPLO_CLI_HOME)
        : join(homedir(), ".eudiplo");

    return join(baseDir, "config.json");
}

export async function loadConfig(path: string): Promise<CliConfig> {
    try {
        const contents = await readFile(path, "utf8");
        return validateConfig(JSON.parse(contents));
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return emptyConfig();
        }
        throw error;
    }
}

export async function saveConfig(
    path: string,
    config: CliConfig,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(config, null, 4)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
}

function validateConfig(value: unknown): CliConfig {
    if (!isRecord(value)) {
        throw new Error("Config must be a JSON object.");
    }

    if (!isRecord(value.instances)) {
        throw new Error("Config must define an instances object.");
    }

    const instances: Record<string, InstanceConfig> = {};
    for (const [name, instance] of Object.entries(value.instances)) {
        instances[name] = validateInstanceConfig(name, instance);
    }

    return {
        defaultInstance: validateDefaultInstance(
            value.defaultInstance,
            instances,
        ),
        instances,
    };
}

export function upsertInstance(
    config: CliConfig,
    name: string,
    instance: InstanceConfig,
): CliConfig {
    return {
        defaultInstance: config.defaultInstance ?? name,
        instances: {
            ...config.instances,
            [name]: instance,
        },
    };
}

export function setDefaultInstance(config: CliConfig, name: string): CliConfig {
    if (!Object.hasOwn(config.instances, name)) {
        throw new Error(`Unknown instance: ${name}`);
    }
    return { ...config, defaultInstance: name };
}

export function removeInstance(config: CliConfig, name: string): CliConfig {
    if (!Object.hasOwn(config.instances, name)) {
        throw new Error(`Unknown instance: ${name}`);
    }
    if (
        config.defaultInstance === name &&
        Object.keys(config.instances).length > 1
    ) {
        throw new Error(
            `Cannot remove default instance ${name}. Select another with: eudiplo instance use <name>`,
        );
    }

    const instances = { ...config.instances };
    delete instances[name];
    return {
        defaultInstance:
            config.defaultInstance === name
                ? undefined
                : config.defaultInstance,
        instances,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function validateDefaultInstance(
    value: unknown,
    instances: Record<string, InstanceConfig>,
): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    if (!Object.hasOwn(instances, value)) {
        throw new Error(
            `Default instance ${value} is not defined in instances.`,
        );
    }
    return value;
}

function validateInstanceConfig(name: string, value: unknown): InstanceConfig {
    if (!isRecord(value)) {
        throw new Error(`Instance ${name} must be an object.`);
    }
    if (
        value.target !== "compose" &&
        value.target !== "external" &&
        value.target !== "kubernetes"
    ) {
        throw new Error(
            `Instance ${name} has unsupported target ${String(value.target)}.`,
        );
    }
    if (typeof value.url !== "string" || value.url.length === 0) {
        throw new Error(`Instance ${name} must define a url.`);
    }

    validateHttpUrl(value.url, `Instance ${name} url`);
    validateOptionalHttpUrl(value.clientUrl, `Instance ${name} clientUrl`);
    if (
        typeof value.projectDirectory === "string" &&
        !isAbsolute(value.projectDirectory)
    ) {
        throw new Error(`Instance ${name} projectDirectory must be absolute.`);
    }

    const workloads = validateWorkloads(name, value.workloads);
    if (value.target === "kubernetes") {
        if (typeof value.context !== "string") {
            throw new Error(`Instance ${name} must define a context.`);
        }
        if (typeof value.namespace !== "string") {
            throw new Error(`Instance ${name} must define a namespace.`);
        }
        if (!workloads) {
            throw new Error(`Instance ${name} must define workloads.`);
        }
    }
    if (typeof value.context === "string") {
        assertContextName(value.context, `Instance ${name} context`);
    }
    if (typeof value.namespace === "string") {
        assertNamespace(value.namespace, `Instance ${name} namespace`);
    }

    return {
        target: value.target,
        url: value.url,
        clientUrl: optionalString(value.clientUrl),
        composeFile: optionalString(value.composeFile),
        composeFiles: optionalStringArray(value.composeFiles),
        composeProfiles: optionalStringArray(
            value.composeProfiles,
            "composeProfiles",
        ),
        envFile: optionalString(value.envFile),
        projectName: optionalString(value.projectName),
        projectDirectory: optionalString(value.projectDirectory),
        context: optionalString(value.context),
        namespace: optionalString(value.namespace),
        workloads,
        readOnly: value.readOnly === true ? true : undefined,
    };
}

function validateWorkloads(
    name: string,
    value: unknown,
): Record<string, string> | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`Instance ${name} workloads must be an object.`);
    }

    const workloads: Record<string, string> = {};
    for (const [service, reference] of Object.entries(value)) {
        if (typeof reference !== "string") {
            throw new Error(
                `Instance ${name} workload ${service} must be a string.`,
            );
        }
        assertWorkloadReference(
            reference,
            `Instance ${name} workload ${service}`,
        );
        workloads[service] = reference;
    }

    if (Object.keys(workloads).length === 0) {
        throw new Error(`Instance ${name} must define at least one workload.`);
    }
    return workloads;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function optionalStringArray(
    value: unknown,
    label = "composeFiles",
): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    if (value.some((item) => typeof item !== "string")) {
        throw new Error(`${label} must contain only strings.`);
    }
    return value;
}

function validateOptionalHttpUrl(value: unknown, label: string): void {
    if (typeof value === "string") {
        validateHttpUrl(value, label);
    }
}

function validateHttpUrl(value: string, label: string): void {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("Unsupported URL protocol.");
        }
    } catch {
        throw new Error(`${label} must be an absolute HTTP(S) URL.`);
    }
}
