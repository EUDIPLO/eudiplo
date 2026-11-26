import type { ConfigDocument } from "@eudiplo/config-format/config-format.js";
import {
    type ConfigPlaceholder,
    readConfigFileValues,
} from "@eudiplo/config-format/config-values.js";
import { holdsUnresolvedPlaceholder } from "./unresolved-placeholder.js";

/**
 * Reads the values of a document of a configuration bundle, in place. A
 * document is a file, whether a request sent it or the folder loader filled
 * it in: `$${` stands for the two characters `${` (an export writes stored
 * text that way) and `${VAR}` is a placeholder nobody resolved. Nothing is
 * read from the backend's environment here.
 *
 * The plan and the apply both call this, so that they see the same values.
 *
 * @returns the placeholders, or undefined for a KMS configuration, which
 * keeps its placeholders (KmsTenantConfigService decides about them).
 */
export function readDocumentFile(
    document: ConfigDocument,
): ConfigPlaceholder[] | undefined {
    if (document.kind === "KmsConfig") return undefined;
    const { value, placeholders } = readConfigFileValues(document.spec);
    document.spec = value;
    return placeholders;
}

/**
 * The JSON pointers of the values that are a placeholder and nothing else.
 * After the read, the text `${VAR}` of an escaped `$${VAR}` looks the same as
 * a placeholder, so the checks that leave a placeholder to SECRET_REQUIRED
 * go by these paths.
 *
 * @returns undefined for a spec that was not read as a document file (no
 * placeholders listed), such as a KMS configuration.
 */
export function wholePlaceholderPaths(
    placeholders: ConfigPlaceholder[] | undefined,
): ReadonlySet<string> | undefined {
    if (!placeholders) return undefined;
    return new Set(
        placeholders
            .filter((placeholder) => placeholder.whole)
            .map((placeholder) => placeholder.path),
    );
}

/**
 * Whether the value at `path` (a JSON pointer into the spec), or a value
 * inside it, is an unresolved placeholder, which the plan reports as
 * SECRET_REQUIRED.
 *
 * @param whole the paths {@link wholePlaceholderPaths} lists for the
 * document; undefined for a spec that was not read as a document file, whose
 * value itself decides.
 */
export function holdsUnresolvedPlaceholderAt(
    whole: ReadonlySet<string> | undefined,
    path: string,
    value: unknown,
): boolean {
    if (!whole) return holdsUnresolvedPlaceholder(value);
    for (const found of whole) {
        if (found === path || found.startsWith(`${path}/`)) return true;
    }
    return false;
}
