import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
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
import { wrapBare } from "./upgrade.js";

/**
 * Where each resource kind lives in a tenant folder and where it goes in a
 * bundle. Mirrors the backend's ConfigFolderBundleService (startup import),
 * plus the tenant's own `info.json`, which a bundle carries as the Tenant
 * document. Bundle paths follow the export (`issuance/config.json`).
 */
export type FolderResource =
    | { kind: ConfigResourceKind; file: string; bundlePath: string }
    | { kind: ConfigResourceKind; directory: string };

export const FOLDER_RESOURCES: readonly FolderResource[] = [
    { kind: "Tenant", file: "info.json", bundlePath: "info.json" },
    { kind: "KmsConfig", file: "kms.json", bundlePath: "kms.json" },
    { kind: "Client", directory: "clients" },
    { kind: "KeyChain", directory: "key-chains" },
    {
        kind: "KeyChainDefaults",
        file: "key-chain-defaults.json",
        bundlePath: "key-chain-defaults.json",
    },
    {
        kind: "RegistrarConfig",
        file: "registrar.json",
        bundlePath: "registrar.json",
    },
    { kind: "AttributeProvider", directory: "attribute-providers" },
    { kind: "WebhookEndpoint", directory: "webhook-endpoints" },
    {
        kind: "IssuanceConfig",
        file: "issuance/issuance.json",
        bundlePath: "issuance/config.json",
    },
    { kind: "CredentialConfig", directory: "issuance/credentials" },
    { kind: "TrustList", directory: "trust-lists" },
    { kind: "FederationTrustAnchor", directory: "federation-trust-anchors" },
    { kind: "PresentationConfig", directory: "presentation" },
    { kind: "StatusList", directory: "issuance/status-lists" },
];

const MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
};

const sha256 = (value: string | Buffer): string =>
    createHash("sha256").update(value).digest("hex");

/**
 * Packs a tenant config folder into a bundle the config-bundles API accepts.
 *
 * `${VAR}` placeholders are resolved from `env`, as the startup import does;
 * one left unresolved stays in the document and the server's plan reports it
 * as SECRET_REQUIRED. Run the offline validation first to catch it earlier.
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
    resource: FolderResource,
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
        .sort((left, right) => left.localeCompare(right));
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
    try {
        const document = normalizeDocument(
            isConfigDocument(resolved)
                ? resolved
                : wrapBare(kind, resolved, file),
        );
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
    const directory = join(tenantRoot, "images");
    if (!existsSync(directory)) return [];
    const assets: ConfigBundleAsset[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const data = await readFile(join(directory, entry.name));
        assets.push({
            path: `images/${entry.name}`,
            contentType:
                MIME_TYPES[extname(entry.name).toLowerCase()] ??
                "application/octet-stream",
            sha256: sha256(data),
            data: data.toString("base64"),
        });
    }
    return assets.sort((left, right) => left.path.localeCompare(right.path));
}
