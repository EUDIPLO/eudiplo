import { createHash } from "node:crypto";
import {
    CONFIG_FORMATS,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import type { ConfigDocument } from "./config-resource.types.js";
import type { ConfigResourceMetadataEntity } from "./entities/config-resource-metadata.entity.js";

/**
 * The `sourceHash` that applying a plan records for a document. Other writers
 * store a hash of the raw file under their own source, so only a document
 * applied through a plan from the same source can match it.
 */
export function documentSourceHash(document: ConfigDocument): string {
    return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

/**
 * Whether `sourceHash` is the hash of this document, migrated to the current
 * format, or of the same document under an earlier format version of its
 * kind. A release records the hash of the document migrated to its own
 * current format, and a format version that migrates a document unchanged
 * changes only `$schema`, so a document an earlier release applied (9.x
 * included) still matches after the upgrade.
 */
function matchesSourceHash(
    document: ConfigDocument,
    sourceHash: string | undefined,
): boolean {
    if (!sourceHash) return false;
    for (
        let version = CONFIG_FORMATS[document.kind].version;
        version >= 1;
        version--
    ) {
        const earlier = {
            ...document,
            $schema: schemaUrl(document.kind, version),
        };
        if (documentSourceHash(earlier) === sourceHash) return true;
    }
    return false;
}

/**
 * Some documents never equal their resource once applied:
 *
 * - A key chain: importers add key IDs, EUDIPLO creates the signing key of a
 *   CA key, and rotation or registrar enrollment replace keys and
 *   certificates.
 * - A client with `"secret": "!generate"`: applying it generates a new secret.
 *
 * So such a document that this source applied as it is, while the resource
 * stayed file-managed, is unchanged, without comparing it with the stored
 * resource. That holds across format versions: see `matchesSourceHash`.
 */
export function documentAppliedAsIs(
    document: ConfigDocument,
    metadata: Pick<
        ConfigResourceMetadataEntity,
        "ownership" | "source" | "sourceHash"
    >,
    source: string,
): boolean {
    const neverEqual =
        document.kind === "KeyChain" ||
        (document.kind === "Client" && document.spec.secret === "!generate");
    return (
        neverEqual &&
        metadata.ownership === "file-managed" &&
        metadata.source === source &&
        matchesSourceHash(document, metadata.sourceHash)
    );
}
