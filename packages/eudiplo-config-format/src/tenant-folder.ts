import type { ConfigResourceKind } from "./config-format.js";

/**
 * Where a resource kind lives in a tenant folder
 * (config-bundle-format.md#tenant-folder-layout): one fixed file, or one file
 * per resource in a directory. `bundlePath` is where a fixed file goes in a
 * config bundle, which names the issuance config `issuance/config.json`.
 */
export type TenantFolderResource =
    | { kind: ConfigResourceKind; file: string; bundlePath: string }
    | { kind: ConfigResourceKind; directory: string };

/**
 * The tenant settings. The startup import applies `info.json` before the other
 * files, so it is kept apart from {@link TENANT_FOLDER_RESOURCES}.
 */
export const TENANT_FOLDER_TENANT: TenantFolderResource = {
    kind: "Tenant",
    file: "info.json",
    bundlePath: "info.json",
};

/** Every other resource kind of a tenant folder, in import order. */
export const TENANT_FOLDER_RESOURCES: readonly TenantFolderResource[] = [
    { kind: "KmsConfig", file: "kms.json", bundlePath: "kms.json" },
    { kind: "Client", directory: "clients" },
    { kind: "KeyChain", directory: "key-chains" },
    {
        kind: "KeyChainDefaults",
        file: "key-chain-defaults.json",
        bundlePath: "key-chain-defaults.json",
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

/** The folder of a tenant's images, and their path prefix in a bundle. */
export const TENANT_FOLDER_IMAGES = "images";

const IMAGE_CONTENT_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
};

/** Content type of an image file of a tenant folder, by its extension. */
export function imageContentType(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    const extension = dot === -1 ? "" : fileName.slice(dot).toLowerCase();
    return IMAGE_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Files that tools put into a folder and that are no images. Other names,
 * hidden ones such as `.logo.png` included, are images of the tenant.
 */
const NOT_IMAGES = new Set([".gitkeep", ".ds_store", "thumbs.db", "desktop.ini"]);

/** Whether a file in `images/` is an image of the tenant. */
export function isTenantFolderImage(fileName: string): boolean {
    return !NOT_IMAGES.has(fileName.toLowerCase());
}

/**
 * Code-point order. Unlike `localeCompare`, it is the same on every machine,
 * so a folder is read, packed and written in the same order everywhere.
 */
export function compareCodePoints(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
