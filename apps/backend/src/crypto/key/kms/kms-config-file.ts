import { join, resolve, sep } from "node:path";
import {
    isConfigDocument,
    migrateDocument,
    normalizeDocument,
} from "@eudiplo/config-format/config-format.js";
import { validateConfigDocument } from "@eudiplo/config-format/config-validator.js";
import { BadRequestException } from "@nestjs/common";

/**
 * Content of a `kms.json` file as the KMS configuration schema expects it.
 *
 * The file is either a configuration document (`$schema` + `spec`, any
 * supported KmsConfig version, migrated to the current one) or a bare file
 * holding only the `spec` content, which is returned unchanged.
 */
export function kmsConfigFileSpec(payload: unknown, source: string): unknown {
    if (!isConfigDocument(payload)) {
        return payload;
    }
    let migrated: ReturnType<typeof migrateDocument>;
    try {
        const { kind } = normalizeDocument(payload);
        if (kind !== "KmsConfig") {
            throw new Error(`expected a KmsConfig document, got ${kind}`);
        }
        migrated = migrateDocument(payload, validateConfigDocument);
    } catch (error) {
        throw new BadRequestException(
            `${source}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const blocking = migrated.issues.filter(
        (issue) => issue.severity !== "warning",
    );
    if (blocking.length > 0) {
        throw new BadRequestException(
            `${source}: ${blocking.map((issue) => issue.message).join("; ")}`,
        );
    }
    return migrated.document.spec;
}

/**
 * Path of the global `kms.json` in `configFolder`, or of the tenant's
 * `<configFolder>/<tenantId>/kms.json`.
 *
 * Tenant IDs are not restricted to a file-name-safe format, so a tenant only
 * has a `kms.json` when its ID is exactly one folder name. For an ID that is
 * empty, `.`, `..` or contains a path separator this returns null instead of
 * the `kms.json` of another folder.
 */
export function kmsConfigFilePath(
    configFolder: string,
    tenantId?: string,
): string | null {
    const root = resolve(configFolder);
    if (tenantId === undefined) {
        return join(root, "kms.json");
    }
    if (tenantId === "." || tenantId === ".." || /^$|[/\\\0]/.test(tenantId)) {
        return null;
    }
    const path = resolve(root, tenantId, "kms.json");
    // Implied by the folder name check above; kept as the containment guard
    // static analysis recognises.
    const prefix = root.endsWith(sep) ? root : root + sep;
    return path.startsWith(prefix) ? path : null;
}
