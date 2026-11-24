import { readFileSync } from "node:fs";

export function loadJsonFile<T>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

/**
 * Load a configuration file and validate it.
 *
 * @param resolvePlaceholders replaces the `${VAR}` placeholders of the file
 * before it is validated (ConfigImportService.replacePlaceholders).
 */
export function loadConfigDto<T extends object>(
    filePath: string,
    validationSchema: any,
    resolvePlaceholders: <V>(value: V) => V,
): T {
    const payload = resolvePlaceholders(loadJsonFile<object>(filePath));

    if (validationSchema?.schema) {
        return validationSchema.schema.parse(payload) as T;
    }

    if (typeof validationSchema?.parse === "function") {
        return validationSchema.parse(payload);
    }

    return payload as T;
}
