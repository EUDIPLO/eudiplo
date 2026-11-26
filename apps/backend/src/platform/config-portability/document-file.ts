import type { ConfigDocument } from "@eudiplo/config-format/config-format.js";
import {
    type ConfigPlaceholder,
    readConfigFileValues,
} from "@eudiplo/config-format/config-values.js";
import { holdsUnresolvedPlaceholder } from "./unresolved-placeholder.js";

/**
 * The values of each spec {@link readDocumentFile} has read that are a
 * placeholder and nothing else, by JSON pointer. After the read, the text
 * `${VAR}` of an escaped `$${VAR}` looks the same as a placeholder, so the
 * checks that leave a placeholder to SECRET_REQUIRED ask here.
 */
const wholePlaceholders = new WeakMap<object, Set<string>>();

/**
 * Reads the values of a document of a configuration bundle, in place. A
 * document is a file, whether a request sent it or the folder loader filled
 * it in: `$${` stands for the two characters `${` (an export writes stored
 * text that way) and `${VAR}` is a placeholder nobody resolved. Nothing is
 * read from the backend's environment here; the placeholders are returned.
 *
 * The plan and the apply both call this, so that they see the same values.
 *
 * @returns undefined for a KMS configuration, whose file has no escaped form
 * and keeps its placeholders (KmsTenantConfigService decides about them).
 */
export function readDocumentFile(
    document: ConfigDocument,
): ConfigPlaceholder[] | undefined {
    if (document.kind === "KmsConfig") return undefined;
    const { value, placeholders } = readConfigFileValues(document.spec);
    document.spec = value;
    wholePlaceholders.set(
        value,
        new Set(
            placeholders
                .filter((placeholder) => placeholder.whole)
                .map((placeholder) => placeholder.path),
        ),
    );
    return placeholders;
}

/**
 * Whether the value at `path` of `spec` (a JSON pointer), or a value inside
 * it, is an unresolved placeholder, which the plan reports as
 * SECRET_REQUIRED. For a spec that was not read as a document file, such as a
 * KMS configuration, the value itself decides.
 */
export function holdsUnresolvedPlaceholderAt(
    spec: object,
    path: string,
    value: unknown,
): boolean {
    const known = wholePlaceholders.get(spec);
    if (!known) return holdsUnresolvedPlaceholder(value);
    for (const found of known) {
        if (found === path || found.startsWith(`${path}/`)) return true;
    }
    return false;
}
