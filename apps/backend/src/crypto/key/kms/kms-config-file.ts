import { join, resolve } from "node:path";
import {
    isConfigDocument,
    migrateDocument,
    normalizeDocument,
} from "@eudiplo/config-format/config-format.js";
import { validateConfigDocument } from "@eudiplo/config-format/config-validator.js";
import { BadRequestException } from "@nestjs/common";
import { tenantConfigFolder } from "../../../shared/utils/tenant-config-folder.util.js";

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
 * `<configFolder>/<tenantId>/kms.json`. Null for a tenant ID that is no
 * folder name (see tenantConfigFolder): such a tenant has no `kms.json`.
 */
export function kmsConfigFilePath(
    configFolder: string,
    tenantId?: string,
): string | null {
    if (tenantId === undefined) {
        return join(resolve(configFolder), "kms.json");
    }
    const folder = tenantConfigFolder(configFolder, tenantId);
    return folder ? join(folder, "kms.json") : null;
}
