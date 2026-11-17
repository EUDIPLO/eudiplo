import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readlink,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CliConfig, InstanceConfig } from "../types.js";
import {
    assertContextName,
    assertNamespace,
    assertWorkloadReference,
} from "./kubectl.js";
import { validateHttpUrl } from "./url.js";

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
 * disk never leaves a truncated config behind. A new config is created with
 * mode 0600 where the platform supports it; an existing one keeps its mode.
 *
 * Where a rename cannot replace the file as it is, the config is rewritten in
 * place as before: when another user or group owns it (a rename would change
 * the owner), when it has hard links, and when the directory is not writable or
 * the file is a mount of its own (a single file bind-mounted into a
 * container).
 *
 * The config is validated first, so no command can save a config that the
 * next command would fail to load. A symlinked config (for example into a
 * dotfiles repository) stays a symlink: the file it points to is replaced.
 */
export async function saveConfig(
    path: string,
    config: CliConfig,
): Promise<void> {
    const contents = `${JSON.stringify(config, null, 4)}\n`;
    validateConfig(JSON.parse(contents));

    const target = await resolveSymlinks(path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const existing = await statIfExists(target);
    if (existing && !canReplace(existing)) {
        await writeFile(target, contents, "utf8");
        return;
    }

    const temporaryPath = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(temporaryPath, contents, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        });
        if (existing) {
            await chmod(temporaryPath, existing.mode & 0o777);
        }
        await replaceFile(temporaryPath, target);
    } catch (error) {
        await rm(temporaryPath, { force: true });
        if (existing && isInPlaceFallback(error)) {
            await writeFile(target, contents, "utf8");
            return;
        }
        throw error;
    }
}

async function statIfExists(path: string): Promise<Stats | undefined> {
    try {
        return await stat(path);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

function canReplace(existing: Stats): boolean {
    if (existing.isFile() && existing.nlink > 1) {
        return false;
    }
    // A rename gives the file the writer's owner and primary group.
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    return (
        (uid === undefined || existing.uid === uid) &&
        (gid === undefined || existing.gid === gid)
    );
}

/**
 * Errors after which the old in-place write still works: no write access to
 * the directory (EACCES, EPERM, EROFS for a read-only mount of the directory
 * only), or a target that cannot be renamed over (EBUSY for a bind-mounted
 * file, EXDEV across mounts).
 */
function isInPlaceFallback(error: unknown): boolean {
    return (
        isNodeError(error) &&
        (error.code === "EACCES" ||
            error.code === "EPERM" ||
            error.code === "EROFS" ||
            error.code === "EBUSY" ||
            error.code === "EXDEV")
    );
}

/**
 * Returns the file a path points to. A path that does not exist yet is
 * returned as is, and a dangling symlink resolves to its missing target, so
 * the first save creates the file the link expects.
 */
async function resolveSymlinks(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
        }
    }
    try {
        if ((await lstat(path)).isSymbolicLink()) {
            return resolve(dirname(path), await readlink(path));
        }
    } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
        }
    }
    return path;
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

    // Object.fromEntries defines own properties, so an instance named
    // `__proto__` is kept instead of replacing the object's prototype.
    const instances: Record<string, InstanceConfig> = Object.fromEntries(
        Object.entries(value.instances).map(([name, instance]) => [
            name,
            validateInstanceConfig(name, instance),
        ]),
    );

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

    // See validateConfig: own properties keep a `__proto__` name intact.
    const instances: Record<string, InstanceConfig> = Object.fromEntries(
        Object.entries(config.instances).map(([name, instance]) => [
            name === oldName ? newName : name,
            instance,
        ]),
    );
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
 * default never points at a missing instance. `newDefault` is refused when
 * another instance is removed; `setDefaultInstance` changes the default.
 */
export function removeInstance(
    config: CliConfig,
    name: string,
    options: { newDefault?: string } = {},
): CliConfig {
    getInstance(config, name);
    const { newDefault } = options;
    if (newDefault !== undefined) {
        if (config.defaultInstance !== name) {
            throw new Error(
                `--default only applies when removing the default instance${config.defaultInstance === undefined ? "" : ` (${config.defaultInstance})`}. To change the default, use: eudiplo instance use <name>`,
            );
        }
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
