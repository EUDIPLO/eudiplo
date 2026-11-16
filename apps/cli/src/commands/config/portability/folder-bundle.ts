import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
    assertConfigBundle,
    type ConfigBundle,
    type ConfigBundleAsset,
} from "@eudiplo/config-format/config-bundle.js";
import {
    type ConfigFile,
    type ConfigResourceKind,
    isConfigDocument,
    normalizeDocument,
    resourceId,
    serializeDocument,
} from "@eudiplo/config-format/config-format.js";
import { resolveConfigVariables } from "@eudiplo/config-format/config-values.js";
import {
    compareCodePoints,
    imageContentType,
    isTenantFolderImage,
    TENANT_FOLDER_IMAGES,
    TENANT_FOLDER_RESOURCES,
    TENANT_FOLDER_TENANT,
    type TenantFolderResource,
} from "@eudiplo/config-format/tenant-folder.js";
import { wrapBare } from "./upgrade.js";

/**
 * The tenant folder layout, shared with the backend's startup import. The
 * tenant's own `info.json` comes first: a bundle carries it as the Tenant
 * document.
 */
export const FOLDER_RESOURCES: readonly TenantFolderResource[] = [
    TENANT_FOLDER_TENANT,
    ...TENANT_FOLDER_RESOURCES,
];

/** Shorter values are only masked where they are the whole string. */
const MIN_MASKED_LENGTH = 8;

export interface FolderEnvironment {
    /** What `${VAR}` placeholders of the folder are filled from. */
    env: Record<string, string | undefined>;
    /** Every value filled in so far, by variable name. */
    filled: Map<string, string>;
    /** Why a variable has no value, when it is not named in `--allow-env`. */
    withheld(variable: string): string | undefined;
}

/**
 * The environment a tenant folder is filled from: only the variables named
 * in `--allow-env` ({@link allowedFolderEnv}). It records the values it hands
 * out, so they can be masked in what the CLI prints ({@link maskFilledValues}).
 */
export function folderEnvironment(
    allowList: string | undefined,
    source: Record<string, string | undefined>,
): FolderEnvironment {
    const allowed = allowedFolderEnv(allowList, source);
    const filled = new Map<string, string>();
    const withheld = (variable: string): string | undefined =>
        Object.hasOwn(allowed, variable)
            ? undefined
            : "not named in --allow-env";
    const env = new Proxy({} as Record<string, string | undefined>, {
        get(_target, name) {
            if (typeof name !== "string" || !Object.hasOwn(allowed, name))
                return undefined;
            const value = allowed[name];
            if (value !== undefined && value !== "") filled.set(name, value);
            return value;
        },
    });
    return { env, filled, withheld };
}

/** Plan and import fields that carry configuration values or quote them. */
const VALUE_KEYS = new Set(["before", "after", "message"]);

/**
 * Replaces values filled in from the environment with their `${VAR}`
 * placeholder in `text`. A value shorter than eight characters is only
 * replaced where it is the whole text.
 */
export function maskFilledText(
    text: string,
    filled: Map<string, string>,
): string {
    const secrets = [...filled]
        .map(([variable, secret]) => ({
            secret,
            placeholder: `\${${variable}}`,
        }))
        // Longest first, so a value that contains another is masked whole.
        .sort((left, right) => right.secret.length - left.secret.length);
    for (const { secret, placeholder } of secrets) {
        if (text === secret) return placeholder;
        if (secret.length >= MIN_MASKED_LENGTH)
            text = text.replaceAll(secret, placeholder);
    }
    return text;
}

/**
 * Masks filled-in values ({@link maskFilledText}) in a plan or import result,
 * so what the CLI prints or saves does not show them in whichever field a
 * placeholder put them. Only field values and messages (`before`, `after`,
 * `message`, and everything below them) are masked; kinds, IDs, actions,
 * codes and the plan fingerprint stay as the server sent them.
 */
export function maskFilledValues<T>(value: T, filled: Map<string, string>): T {
    if (filled.size === 0) return value;
    const visit = (item: unknown, masked: boolean): unknown => {
        if (typeof item === "string")
            return masked ? maskFilledText(item, filled) : item;
        if (Array.isArray(item))
            return item.map((entry) => visit(entry, masked));
        if (!item || typeof item !== "object") return item;
        return Object.fromEntries(
            Object.entries(item).map(([key, entry]) => [
                key,
                visit(entry, masked || VALUE_KEYS.has(key)),
            ]),
        );
    };
    return visit(value, false) as T;
}

const sha256 = (value: string | Buffer): string =>
    createHash("sha256").update(value).digest("hex");

/**
 * The CLI's own credentials. A folder can never read them through `${VAR}`,
 * even when they are named in `--allow-env`.
 */
const CLI_CREDENTIAL_VARIABLES = new Set([
    "EUDIPLO_TOKEN",
    "EUDIPLO_CLIENT_ID",
    "EUDIPLO_CLIENT_SECRET",
]);

/**
 * The environment a tenant folder's `${VAR}` placeholders resolve from: only
 * the variables named in `--allow-env` (comma-separated). The folder's author
 * is not necessarily the one who controls the environment (a CI job planning a
 * Git repository), so the folder must not be able to read arbitrary variables
 * into values the plan prints and the instance stores.
 */
function allowedFolderEnv(
    allowList: string | undefined,
    env: Record<string, string | undefined>,
): Record<string, string | undefined> {
    const allowed: Record<string, string | undefined> = {};
    for (const name of (allowList ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)) {
        if (!/^[A-Z0-9_]+$/.test(name))
            throw new Error(
                `--allow-env: "${name}" is not a placeholder variable name (A-Z, 0-9, _).`,
            );
        if (CLI_CREDENTIAL_VARIABLES.has(name))
            throw new Error(
                `--allow-env: ${name} holds the CLI's own credentials and cannot be used in configuration.`,
            );
        allowed[name] = env[name];
    }
    return allowed;
}

/**
 * Refuses a tenant folder with a symbolic link that resolves outside the
 * folder, or does not resolve at all. Otherwise a link committed to a config
 * repository (`images -> ~/.ssh`) would make the CLI upload files from the
 * machine that runs it. Links inside the folder (for example a Kubernetes
 * ConfigMap mount) stay allowed.
 */
export async function assertFolderContained(tenantRoot: string): Promise<void> {
    const root = await realpath(tenantRoot);
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop() as string;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) pending.push(path);
            if (!entry.isSymbolicLink()) continue;
            const shown = relative(root, path);
            let target: string;
            try {
                target = await realpath(path);
            } catch {
                throw new Error(
                    `${shown}: symbolic link does not resolve. Remove it from the configuration folder.`,
                );
            }
            if (!target.startsWith(`${root}${sep}`))
                throw new Error(
                    `${shown}: symbolic link points outside the configuration folder. Copy the file into the folder instead.`,
                );
        }
    }
}

/**
 * Packs a tenant config folder into a bundle the config-bundles API accepts.
 * The folder must be validated (`validateTenantDirectory`) and checked with
 * `assertFolderContained` first; the CLI command does both.
 *
 * `${VAR}` placeholders are resolved from `env`; pass a
 * {@link folderEnvironment}, not the process environment. One left unresolved
 * stays in the document and the server's plan reports it as SECRET_REQUIRED.
 *
 * The result is deterministic for the same folder and environment (sorted
 * files, fixed `exportedAt`), so a plan and the import that applies it agree
 * on the plan fingerprint.
 */
export async function packTenantFolder(
    tenantRoot: string,
    env: Record<string, string | undefined>,
): Promise<ConfigBundle> {
    const documents: ConfigFile[] = [];
    const resources: ConfigBundle["manifest"]["resources"] = [];

    for (const resource of FOLDER_RESOURCES) {
        for (const file of await resourceFiles(tenantRoot, resource)) {
            const document = await loadDocument(
                tenantRoot,
                file,
                resource.kind,
                env,
            );
            const id = resourceId(document);
            documents.push(document);
            resources.push({
                kind: resource.kind,
                id,
                $schema: document.$schema as string,
                path:
                    "bundlePath" in resource
                        ? resource.bundlePath
                        : `${resource.directory}/${id}.json`,
                sha256: sha256(JSON.stringify(document)),
                ownership: "file-managed",
                generation: document.metadata?.generation ?? 1,
            });
        }
    }
    if (documents.length === 0)
        throw new Error(
            `No configuration files found in ${tenantRoot}. Expected a tenant folder (info.json, clients/, key-chains/, ...).`,
        );

    const assets = await loadAssets(tenantRoot);
    const bundle: ConfigBundle = {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 2,
            sourceVersion: "cli-folder",
            exportedAt: new Date(0).toISOString(),
            tenant: basename(tenantRoot),
            resources,
            assets: assets.map(({ path, contentType, sha256: hash }) => ({
                path,
                contentType,
                sha256: hash,
            })),
            requirements: [],
            warnings: [],
        },
        documents,
        assets,
    };
    assertConfigBundle(bundle);
    return bundle;
}

async function resourceFiles(
    tenantRoot: string,
    resource: TenantFolderResource,
): Promise<string[]> {
    if ("file" in resource) {
        const path = join(tenantRoot, resource.file);
        return existsSync(path) ? [resource.file] : [];
    }
    const directory = join(tenantRoot, resource.directory);
    if (!existsSync(directory)) return [];
    return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => `${resource.directory}/${entry.name}`)
        .sort(compareCodePoints);
}

async function loadDocument(
    tenantRoot: string,
    file: string,
    kind: ConfigResourceKind,
    env: Record<string, string | undefined>,
): Promise<ConfigFile> {
    let payload: unknown;
    try {
        // The parser's message can quote a secret from the file; do not repeat it.
        payload = JSON.parse(await readFile(join(tenantRoot, file), "utf8"));
    } catch {
        throw new Error(`${file}: is not valid JSON`);
    }
    const resolved = resolveConfigVariables(payload, env).value;
    // wrapBare names the file in its own errors.
    const input = isConfigDocument(resolved)
        ? resolved
        : wrapBare(kind, resolved, file);
    try {
        const document = normalizeDocument(input);
        if (document.kind !== kind)
            throw new Error(`contains ${document.kind}, expected ${kind}`);
        return serializeDocument(document) as ConfigFile;
    } catch (error) {
        throw new Error(
            `${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function loadAssets(tenantRoot: string): Promise<ConfigBundleAsset[]> {
    const directory = join(tenantRoot, TENANT_FOLDER_IMAGES);
    if (!existsSync(directory)) return [];
    const assets: ConfigBundleAsset[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !isTenantFolderImage(entry.name)) continue;
        const data = await readFile(join(directory, entry.name));
        assets.push({
            path: `${TENANT_FOLDER_IMAGES}/${entry.name}`,
            contentType: imageContentType(entry.name),
            sha256: sha256(data),
            data: data.toString("base64"),
        });
    }
    return assets.sort((left, right) =>
        compareCodePoints(left.path, right.path),
    );
}
