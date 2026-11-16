import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type {
    ConfigFile,
    ConfigMigrationIssue,
    ConfigResourceKind,
} from "./config-format.js";
import {
    normalizeDocument,
    resolveConfigIdentity,
    resourceId,
} from "./config-format.js";
interface ConfigBundleResource {
    kind: ConfigResourceKind;
    id: string;
    $schema: string;
    path: string;
    sha256: string;
    ownership: "unmanaged" | "file-managed";
    generation: number;
}

export interface ConfigBundleRequirement {
    code: string;
    resource: { kind: ConfigResourceKind; id: string };
    path: string;
    message: string;
    placeholder?: string;
}

export interface ConfigBundleAsset {
    path: string;
    contentType?: string;
    sha256: string;
    data: string;
}

interface ConfigBundleManifest {
    format: "eudiplo.config-bundle";
    formatVersion: 1 | 2;
    sourceVersion: string;
    exportedAt: string;
    tenant: string;
    resources: ConfigBundleResource[];
    assets: Array<{
        path: string;
        contentType?: string;
        sha256: string;
    }>;
    requirements: ConfigBundleRequirement[];
    warnings: ConfigMigrationIssue[];
}

export interface ConfigBundle {
    manifest: ConfigBundleManifest;
    documents: ConfigFile[];
    assets: ConfigBundleAsset[];
}

const sha256 = (value: Uint8Array): string =>
    createHash("sha256").update(value).digest("hex");

const ZIP_ENTRY_TIME = new Date(1980, 0, 1);

export class ConfigBundleCodec {
    encode(bundle: ConfigBundle): Buffer {
        assertConfigBundle(bundle);
        const entries: Record<string, Uint8Array> = {
            "manifest.json": strToU8(JSON.stringify(bundle.manifest, null, 2)),
        };
        for (const resource of bundle.manifest.resources) {
            assertSafeBundlePath(resource.path);
            const document = bundle.documents.find(
                (candidate) =>
                    normalizeDocument(candidate).kind === resource.kind &&
                    resolveConfigIdentity(candidate).version ===
                        resolveConfigIdentity(resource).version &&
                    resourceId(candidate) === resource.id,
            );
            if (!document) {
                throw new Error(
                    `Bundle document is missing for ${resource.kind} at ${resource.path}`,
                );
            }
            const bytes = strToU8(JSON.stringify(document));
            if (sha256(bytes) !== resource.sha256) {
                throw new Error(
                    `Resource checksum mismatch while packing ${resource.path}`,
                );
            }
            entries[resource.path] = bytes;
        }
        for (const asset of bundle.assets ?? []) {
            assertSafeBundlePath(asset.path);
            const bytes = new Uint8Array(Buffer.from(asset.data, "base64"));
            if (sha256(bytes) !== asset.sha256) {
                throw new Error(
                    `Asset checksum mismatch while packing ${asset.path}`,
                );
            }
            entries[asset.path] = bytes;
        }
        // A fixed entry time (the earliest a ZIP can hold) keeps the archive
        // the same for the same bundle, so a plan and its import send equal bytes.
        return Buffer.from(
            zipSync(entries, { level: 6, mtime: ZIP_ENTRY_TIME }),
        );
    }

    decode(input: Buffer): ConfigBundle {
        if (input.byteLength > 50 * 1024 * 1024) {
            throw new Error("Configuration ZIP exceeds 50 MiB");
        }
        this.inspectCentralDirectory(input);
        let entries: Record<string, Uint8Array>;
        try {
            entries = unzipSync(new Uint8Array(input));
        } catch (error) {
            throw new Error(
                `Invalid configuration ZIP: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        for (const path of Object.keys(entries)) assertSafeBundlePath(path);
        const expandedSize = Object.values(entries).reduce(
            (total, value) => total + value.byteLength,
            0,
        );
        if (expandedSize > 100 * 1024 * 1024) {
            throw new Error("Expanded configuration ZIP exceeds 100 MiB");
        }
        const manifestBytes = entries["manifest.json"];
        if (!manifestBytes) {
            throw new Error("Configuration ZIP has no manifest.json");
        }
        const manifest = this.parseJson(
            strFromU8(manifestBytes),
            "manifest.json",
        ) as ConfigBundle["manifest"];
        assertBundleManifest(manifest);
        const documents: ConfigFile[] = [];
        for (const resource of manifest.resources ?? []) {
            assertSafeBundlePath(resource.path);
            const bytes = entries[resource.path];
            if (!bytes) {
                throw new Error(`Missing resource: ${resource.path}`);
            }
            if (sha256(bytes) !== resource.sha256) {
                throw new Error(`Resource checksum mismatch: ${resource.path}`);
            }
            documents.push(
                this.parseJson(strFromU8(bytes), resource.path) as ConfigFile,
            );
        }
        const assets: ConfigBundleAsset[] = (manifest.assets ?? []).map(
            (asset) => {
                assertSafeBundlePath(asset.path);
                const bytes = entries[asset.path];
                if (!bytes || sha256(bytes) !== asset.sha256) {
                    throw new Error(`Missing or invalid asset: ${asset.path}`);
                }
                return {
                    ...asset,
                    data: Buffer.from(bytes).toString("base64"),
                };
            },
        );
        // ZIP checksums cover entry bytes. After verification, use compact JSON
        // checksums for the structured bundle consumed by the same JSON validator.
        manifest.resources.forEach((resource, index) => {
            resource.sha256 = sha256(
                Buffer.from(JSON.stringify(documents[index])),
            );
        });
        const bundle = { manifest, documents, assets };
        assertConfigBundle(bundle);
        const declared = new Set([
            "manifest.json",
            ...manifest.resources.map((r) => r.path),
            ...manifest.assets.map((a) => a.path),
        ]);
        for (const path of Object.keys(entries))
            if (!declared.has(path))
                throw new Error(`Unlisted ZIP entry: ${path}`);
        return bundle;
    }

    /**
     * Read central-directory metadata before fflate allocates expanded entry
     * buffers. This makes the expanded-size limit effective against ZIP bombs.
     */
    private inspectCentralDirectory(input: Buffer): void {
        const eocdSignature = 0x06054b50;
        const centralSignature = 0x02014b50;
        const minimumEocdOffset = Math.max(0, input.length - 65_557);
        let eocd = -1;
        for (
            let offset = input.length - 22;
            offset >= minimumEocdOffset;
            offset--
        ) {
            if (input.readUInt32LE(offset) === eocdSignature) {
                eocd = offset;
                break;
            }
        }
        if (eocd < 0) {
            throw new Error("Invalid configuration ZIP directory");
        }
        const entryCount = input.readUInt16LE(eocd + 10);
        const centralSize = input.readUInt32LE(eocd + 12);
        const centralOffset = input.readUInt32LE(eocd + 16);
        if (
            entryCount === 0xffff ||
            centralSize === 0xffffffff ||
            centralOffset === 0xffffffff
        ) {
            throw new Error("ZIP64 configuration archives are not supported");
        }
        if (entryCount > 10_000) {
            throw new Error("Configuration ZIP contains too many entries");
        }
        if (centralOffset + centralSize > eocd) {
            throw new Error("Invalid configuration ZIP directory");
        }
        let offset = centralOffset;
        let expandedSize = 0;
        const paths = new Set<string>();
        for (let index = 0; index < entryCount; index++) {
            if (
                offset + 46 > centralOffset + centralSize ||
                input.readUInt32LE(offset) !== centralSignature
            ) {
                throw new Error("Invalid configuration ZIP directory entry");
            }
            const flags = input.readUInt16LE(offset + 8);
            if ((flags & 1) !== 0) {
                throw new Error("Encrypted ZIP entries are not supported");
            }
            const uncompressedSize = input.readUInt32LE(offset + 24);
            if (uncompressedSize === 0xffffffff) {
                throw new Error(
                    "ZIP64 configuration entries are not supported",
                );
            }
            expandedSize += uncompressedSize;
            if (expandedSize > 100 * 1024 * 1024) {
                throw new Error("Expanded configuration ZIP exceeds 100 MiB");
            }
            const filenameLength = input.readUInt16LE(offset + 28);
            const extraLength = input.readUInt16LE(offset + 30);
            const commentLength = input.readUInt16LE(offset + 32);
            const nextOffset =
                offset + 46 + filenameLength + extraLength + commentLength;
            if (nextOffset > centralOffset + centralSize) {
                throw new Error(
                    "Invalid configuration ZIP directory entry length",
                );
            }
            const path = input
                .subarray(offset + 46, offset + 46 + filenameLength)
                .toString("utf8");
            assertSafeBundlePath(path);
            if (paths.has(path)) {
                throw new Error(`Duplicate configuration ZIP path: ${path}`);
            }
            paths.add(path);
            offset = nextOffset;
        }
        if (offset !== centralOffset + centralSize) {
            throw new Error("Invalid configuration ZIP directory size");
        }
    }

    private parseJson(value: string, path: string): unknown {
        try {
            return JSON.parse(value);
        } catch {
            throw new Error(`Invalid JSON in ${path}`);
        }
    }
}

function assertSafeBundlePath(path: unknown): asserts path is string {
    if (
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        /^[A-Za-z]:/.test(path) ||
        path.includes("\\") ||
        /[\x00-\x1f]/.test(path) ||
        path
            .split("/")
            .some((part) => part === ".." || part === "." || part === "")
    )
        throw new Error(`Unsafe bundle path: ${String(path)}`);
}
function assertBundleManifest(manifest: ConfigBundleManifest): void {
    if (
        manifest?.format !== "eudiplo.config-bundle" ||
        ![1, 2].includes(manifest.formatVersion) ||
        !Array.isArray(manifest.resources) ||
        !Array.isArray(manifest.assets) ||
        typeof manifest.tenant !== "string"
    )
        throw new Error("Invalid configuration bundle manifest");
    const paths = new Set(["manifest.json"]);
    const identities = new Set<string>();
    for (const resource of manifest.resources) {
        if (!resource || typeof resource.id !== "string" || !resource.id)
            throw new Error("Invalid manifest resource");
        const identity = resolveConfigIdentity(resource);
        if (identity.kind !== resource.kind)
            throw new Error("Manifest kind conflicts with schema");
        const key = `${resource.kind}/${resource.id}`;
        if (identities.has(key)) throw new Error(`Duplicate resource: ${key}`);
        identities.add(key);
    }
    for (const entry of [...manifest.resources, ...manifest.assets]) {
        if (!entry) throw new Error("Invalid manifest entry");
        assertSafeBundlePath(entry.path);
        if (paths.has(entry.path))
            throw new Error(`Duplicate bundle path: ${entry.path}`);
        paths.add(entry.path);
        if (
            typeof entry.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)
        )
            throw new Error(`Invalid checksum: ${entry.path}`);
    }
}
export function assertConfigBundle(
    input: unknown,
): asserts input is ConfigBundle {
    const bundle = input as ConfigBundle;
    assertBundleManifest(bundle?.manifest);
    if (
        !Array.isArray(bundle.documents) ||
        bundle.documents.length !== bundle.manifest.resources.length ||
        !Array.isArray(bundle.assets) ||
        bundle.assets.length !== bundle.manifest.assets.length
    )
        throw new Error("Manifest counts do not match bundle contents");
    const seen = new Set<string>();
    for (const file of bundle.documents) {
        const document = normalizeDocument(file);
        const key = `${document.kind}/${resourceId(file)}`;
        if (seen.has(key)) throw new Error(`Duplicate resource: ${key}`);
        seen.add(key);
        const entry = bundle.manifest.resources.find(
            (r) => r.kind === document.kind && r.id === resourceId(file),
        );
        if (
            !entry ||
            resolveConfigIdentity(entry).version !==
                resolveConfigIdentity(document).version
        )
            throw new Error(`Missing or mismatched manifest entry: ${key}`);
        if (entry.sha256 !== sha256(Buffer.from(JSON.stringify(file))))
            throw new Error(`Resource checksum mismatch: ${entry.path}`);
    }
    const assetPaths = new Set<string>();
    for (const asset of bundle.assets) {
        if (
            !asset ||
            typeof asset.data !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                asset.data,
            )
        )
            throw new Error("Invalid base64 asset");
        if (assetPaths.has(asset.path))
            throw new Error(`Duplicate asset: ${asset.path}`);
        assetPaths.add(asset.path);
        const entry = bundle.manifest.assets.find((a) => a.path === asset.path);
        if (
            !entry ||
            entry.sha256 !== asset.sha256 ||
            asset.sha256 !== sha256(Buffer.from(asset.data, "base64"))
        )
            throw new Error(`Missing or invalid asset: ${asset.path}`);
    }
}
