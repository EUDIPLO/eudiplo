import { createHash } from "node:crypto";
import {
    earlierSpecs,
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
 * format, or of the document it was under an earlier format version of its
 * kind. A release records the hash of the document migrated to its own
 * current format. A format version that migrates a document unchanged changes
 * only `$schema`, and a step that rewrites the spec names the specs it came
 * from (`earlierSpecs`), so a document an earlier release applied (9.x
 * included) still matches after the upgrade.
 */
function matchesSourceHash(
    document: ConfigDocument,
    sourceHash: string | undefined,
): boolean {
    if (!sourceHash) return false;
    for (const { version, specs } of earlierSpecs(
        document.kind,
        document.spec,
    )) {
        for (const spec of specs) {
            const earlier = {
                ...document,
                $schema: schemaUrl(document.kind, version),
                spec,
            };
            if (documentSourceHash(earlier) === sourceHash) return true;
        }
    }
    return false;
}

/**
 * Some documents never equal their resource once applied:
 *
 * - A key chain: importers add key IDs, EUDIPLO creates the signing key of a
 *   CA key, and rotation replaces keys and certificates.
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
