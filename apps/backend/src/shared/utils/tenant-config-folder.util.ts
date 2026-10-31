import { resolve, sep } from "node:path";

/** Files in the configuration folder itself, which are no tenant folder. */
const RESERVED_NAMES = new Set(["kms.json"]);

/**
 * Absolute path of the tenant's folder `<configFolder>/<tenantId>`.
 *
 * New tenant IDs match TENANT_ID_PATTERN, but tenants created before 10.0 and
 * folders found at startup may have any ID, so a tenant only has a config
 * folder when its ID is exactly one folder name. For an ID that is empty,
 * `.`, `..`, the name of a file in the configuration folder, or contains a
 * path separator or NUL this returns null instead of another path, such as
 * the folder of the tenant `victim` for `x/../victim`.
 */
export function tenantConfigFolder(
    configFolder: string,
    tenantId: string,
): string | null {
    if (
        tenantId === "." ||
        tenantId === ".." ||
        RESERVED_NAMES.has(tenantId.toLowerCase()) ||
        /^$|[/\\\0]/.test(tenantId)
    ) {
        return null;
    }
    const root = resolve(configFolder);
    const folder = resolve(root, tenantId);
    // Implied by the folder name check above; kept as the containment guard
    // static analysis recognises.
    const prefix = root.endsWith(sep) ? root : root + sep;
    return folder.startsWith(prefix) ? folder : null;
}
