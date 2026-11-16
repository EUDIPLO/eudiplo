import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { ConfigBundle } from "@eudiplo/config-format/config-bundle.js";
import {
    type ConfigResourceKind,
    normalizeDocument,
    resourceId,
} from "@eudiplo/config-format/config-format.js";
import { atomicWriteFile } from "@eudiplo/config-format/config-io.js";
import { FOLDER_RESOURCES } from "./folder-bundle.js";

export interface WrittenTenantFolder {
    /** Folder path of each resource, keyed `<kind>/<id>`, with `/` separators. */
    files: Map<string, string>;
    assets: number;
}

/**
 * Writes an exported bundle as a tenant folder in the layout the startup
 * import and `config plan <folder>` read
 * (config-bundle-format.md#tenant-folder-layout).
 *
 * Documents are written as the export has them, `${…}` placeholders and
 * `keySource: { "type": "required" }` included. File names come from the
 * resource ID and keys are sorted, so exporting the same configuration again
 * produces the same files and a readable `git diff`.
 *
 * The folder is assembled next to `destination` and moved into place at the
 * end, so a failed export leaves no partial folder. `destination` must not
 * exist or be an empty directory.
 */
export async function writeTenantFolder(
    bundle: ConfigBundle,
    destination: string,
): Promise<WrittenTenantFolder> {
    await assertEmptyTarget(destination);
    const files = folderPaths(bundle);
    await mkdir(dirname(destination), { recursive: true });
    const staging = await mkdtemp(
        join(dirname(destination), ".eudiplo-export-"),
    );
    try {
        for (const document of bundle.documents) {
            const normalized = normalizeDocument(document);
            const path = files.get(
                `${normalized.kind}/${resourceId(document)}`,
            )!;
            await writeFileIn(staging, path, serializeForFolder(document));
        }
        for (const asset of bundle.assets) {
            // The codec already rejected unsafe paths; keep images where the
            // folder layout expects them.
            if (!asset.path.startsWith("images/"))
                throw new Error(
                    `Unexpected asset path in export: ${asset.path}`,
                );
            await writeFileIn(
                staging,
                asset.path,
                Buffer.from(asset.data, "base64"),
            );
        }
        // An empty target directory is replaced; rename onto it fails on Windows.
        await rmdir(destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
        await rename(staging, destination);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    return { files, assets: bundle.assets.length };
}

async function writeFileIn(
    root: string,
    path: string,
    data: string | Buffer,
): Promise<void> {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await atomicWriteFile(target, data);
}

/** Folder path of every document of the bundle, keyed `<kind>/<id>`. */
function folderPaths(bundle: ConfigBundle): Map<string, string> {
    const paths = new Map<string, string>();
    const taken = new Set<string>();
    const ordered = bundle.documents
        .map((document) => ({
            kind: normalizeDocument(document).kind,
            id: resourceId(document),
        }))
        // Code-point order, not localeCompare: the same on every machine, so
        // the same ID gets the hash suffix on every export.
        .sort((left, right) => {
            const a = `${left.kind}/${left.id}`;
            const b = `${right.kind}/${right.id}`;
            return a < b ? -1 : a > b ? 1 : 0;
        });
    for (const { kind, id } of ordered) {
        const resource = layoutOf(kind);
        let path =
            "file" in resource
                ? resource.file
                : `${resource.directory}/${fileName(id)}.json`;
        // IDs that differ only in case share a file on Windows and macOS.
        if (taken.has(path.toLowerCase()) && "directory" in resource)
            path = `${resource.directory}/${fileName(id)}-${shortHash(id)}.json`;
        if (taken.has(path.toLowerCase()))
            throw new Error(`Two resources map to the same file: ${path}`);
        taken.add(path.toLowerCase());
        paths.set(`${kind}/${id}`, path);
    }
    return paths;
}

/**
 * `$schema`, `metadata`, `spec` in that order, keys within sorted, two-space
 * indentation and a final newline, like the repository's own config files.
 */
function serializeForFolder(document: unknown): string {
    const { $schema, metadata, spec } = document as Record<string, unknown>;
    return `${JSON.stringify(
        sortKeys({
            $schema,
            ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
            spec,
        }),
        null,
        2,
    )}\n`;
}

function sortKeys(value: unknown, top = true): unknown {
    if (Array.isArray(value)) return value.map((item) => sortKeys(item, false));
    if (!value || typeof value !== "object") return value;
    const keys = Object.keys(value);
    // Keep the envelope order; sort everything below it.
    if (!top) keys.sort();
    return Object.fromEntries(
        keys
            .filter((key) => (value as any)[key] !== undefined)
            .map((key) => [key, sortKeys((value as any)[key], false)]),
    );
}

function layoutOf(kind: ConfigResourceKind) {
    const resource = FOLDER_RESOURCES.find((entry) => entry.kind === kind);
    if (!resource)
        throw new Error(`The tenant folder layout has no place for ${kind}`);
    return resource;
}

/** An ID as a file name that is valid on Linux, macOS and Windows. */
function fileName(id: string): string {
    if (
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) &&
        !/\.$/.test(id) &&
        !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(id)
    )
        return id;
    const safe = id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
    return `${safe.slice(0, 80) || "resource"}-${shortHash(id)}`;
}

function shortHash(id: string): string {
    return createHash("sha256").update(id).digest("hex").slice(0, 8);
}

async function assertEmptyTarget(destination: string): Promise<void> {
    let entries: string[];
    try {
        entries = await readdir(destination);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code === "ENOTDIR")
            throw new Error(
                `Output exists and is not a directory: ${destination}`,
            );
        throw error;
    }
    if (entries.length > 0)
        throw new Error(
            `Output directory is not empty: ${destination}${sep}. Export to a new or empty directory, then compare or move the files.`,
        );
}
