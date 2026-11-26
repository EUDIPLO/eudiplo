import {
    migrateDocument,
    serializeDocument,
} from "@eudiplo/config-format/config-format.js";
import { validateConfigFile } from "@eudiplo/config-format/config-validator.js";

/**
 * Upgrades a configuration file. The schema check sees the values the file
 * holds ({@link validateConfigFile}), as the backend checks them.
 */
export function upgradeDocument(input: unknown) {
    const result = migrateDocument(input, validateConfigFile);
    return { ...result, document: serializeDocument(result.document) };
}
