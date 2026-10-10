import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/**
 * Writes the config atomically: the content goes to a new file in the same
 * directory, which then replaces the config in one rename. A crash or a full
 * disk never leaves a truncated config behind, and the new file is created
 * with mode 0600 where the platform supports it.
 *
 * The config is validated first, so no command can save a config that the
 * next command would fail to load.
 */
export async function saveConfig(
    path: string,
    config: CliConfig,
): Promise<void> {
    const contents = `${JSON.stringify(config, null, 4)}\n`;
    validateConfig(JSON.parse(contents));

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(temporaryPath, contents, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        });
        await replaceFile(temporaryPath, path);
    } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
    }
}

/**
 * Renames over the existing file. On Windows a rename can fail briefly while
 * another process (an editor, a virus scanner) holds the target open.
 */
async function replaceFile(source: string, target: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await rename(source, target);
            return;
        } catch (error) {
            const retryable =
                process.platform === "win32" &&
                isNodeError(error) &&
                (error.code === "EPERM" ||
                    error.code === "EACCES" ||
                    error.code === "EBUSY");
            if (!retryable || attempt >= 5) {
                throw error;
            }
            await new Promise((done) => setTimeout(done, attempt * 20));
        }
    }
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

/**
 * Looks up an instance by name. Only the config's own entries count, so names
 * such as `constructor` are unknown instead of resolving to Object members.
 */
export function getInstance(config: CliConfig, name: string): InstanceConfig {
    if (!Object.hasOwn(config.instances, name)) {
        throw new Error(`Unknown instance: ${name}`);
    }
    return config.instances[name];
}

export function setDefaultInstance(config: CliConfig, name: string): CliConfig {
    getInstance(config, name);
    return { ...config, defaultInstance: name };
}

export interface InstanceUpdate {
    url?: string;
    /** A URL replaces the client URL, `null` removes it. */
    clientUrl?: string | null;
}

export function updateInstance(
    config: CliConfig,
    name: string,
    update: InstanceUpdate,
): CliConfig {
    const current = getInstance(config, name);
    if (update.url === undefined && update.clientUrl === undefined) {
        throw new Error(
            "Nothing to update. Pass --url, --client-url or --no-client-url.",
        );
    }
    if (update.url !== undefined) {
        validateHttpUrl(update.url, "--url");
    }
    if (typeof update.clientUrl === "string") {
        validateHttpUrl(update.clientUrl, "--client-url");
    }

    const next: InstanceConfig = { ...current };
    if (update.url !== undefined) {
        next.url = update.url;
    }
    if (update.clientUrl === null) {
        delete next.clientUrl;
    } else if (update.clientUrl !== undefined) {
        next.clientUrl = update.clientUrl;
    }
    return {
        ...config,
        instances: { ...config.instances, [name]: next },
    };
}

/**
 * Renames an instance, keeping its position in the config file and moving the
 * default along with it.
 */
export function renameInstance(
    config: CliConfig,
    oldName: string,
    newName: string,
): CliConfig {
    getInstance(config, oldName);
    if (newName.length === 0) {
        throw new Error("New instance name must not be empty.");
    }
    if (newName === oldName) {
        throw new Error(`Instance ${oldName} already has that name.`);
    }
    if (Object.hasOwn(config.instances, newName)) {
        throw new Error(`Instance ${newName} already exists.`);
    }

    const instances: Record<string, InstanceConfig> = {};
    for (const [name, instance] of Object.entries(config.instances)) {
        instances[name === oldName ? newName : name] = instance;
    }
    return {
        defaultInstance:
            config.defaultInstance === oldName
                ? newName
                : config.defaultInstance,
        instances,
    };
}

/**
 * Removes an instance. The default can only be removed while it is the last
 * instance, or when `newDefault` names the instance that replaces it, so the
 * default never points at a missing instance.
 */
export function removeInstance(
    config: CliConfig,
    name: string,
    options: { newDefault?: string } = {},
): CliConfig {
    getInstance(config, name);
    const { newDefault } = options;
    if (newDefault !== undefined) {
        if (newDefault === name) {
            throw new Error(
                `Cannot make ${name} the default while removing it.`,
            );
        }
        getInstance(config, newDefault);
    }
    if (
        config.defaultInstance === name &&
        newDefault === undefined &&
        Object.keys(config.instances).length > 1
    ) {
        throw new Error(
            `Cannot remove default instance ${name}. Select another with: eudiplo instance use <name>, or pass --default <name>.`,
        );
    }

    const instances = { ...config.instances };
    delete instances[name];
    return {
        defaultInstance:
            newDefault ??
            (config.defaultInstance === name
                ? undefined
                : config.defaultInstance),
        instances,
    };
}

/**
 * Hides user info such as `user:password@` in a URL before it is printed.
 * Other URLs are returned exactly as configured.
 */
export function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.username === "" && url.password === "") {
            return value;
        }
    } catch {
        return value;
    }
    return value.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i, "$1***@");
}

/** Throws unless `value` is an absolute HTTP(S) URL, as config loading requires. */
export function assertHttpUrl(value: string, label: string): void {
    validateHttpUrl(value, label);
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
