import { Ajv2020 } from "ajv/dist/2020.js";
import {
    type ConfigDocument,
    type ConfigMigrationIssue,
    resolveConfigIdentity,
    resourceId,
    serializeDocument,
} from "./config-format.js";
import { CONFIG_SCHEMAS } from "./config-schemas.generated.js";
import {
    DISPLAY_COLOR_MESSAGE,
    duplicateDisplayLocaleMessage,
    findDuplicateDisplayLocales,
} from "./display-entries.js";

// Ajv quotes the pattern, which is unreadable for display colors.
const DISPLAY_COLOR_PATH = /^\/spec\/config\/display\/\d+\/(?:background|text)_color$/;

// JSON Schema shape validation is offline and non-mutating. Runtime domain
// validators additionally enforce formats, defaults and cross-resource semantics.
const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
});
for (const schema of CONFIG_SCHEMAS) ajv.addSchema(schema);
export function validateConfigDocument(
    document: ConfigDocument,
): ConfigMigrationIssue[] {
    const file = serializeDocument(document);
    const validate = ajv.getSchema(file.$schema);
    if (!validate) throw new Error(`No bundled validator for ${file.$schema}`);
    const issues: ConfigMigrationIssue[] = [];
    if (!validate(file)) {
        for (const issue of validate.errors ?? [])
            issues.push({
                severity: "error",
                code: "CONFIG_SCHEMA_VALIDATION_FAILED",
                path: issue.instancePath || "/",
                message:
                    issue.keyword === "additionalProperties"
                        ? `Unknown property: ${String(issue.params.additionalProperty)}`
                        : issue.keyword === "pattern" &&
                            DISPLAY_COLOR_PATH.test(issue.instancePath)
                          ? DISPLAY_COLOR_MESSAGE
                          : (issue.message ?? "Invalid configuration"),
                resource: { kind: document.kind, id: resourceId(document) },
            });
    }
    const id =
        document.kind === "Client" ? document.spec.clientId : document.spec.id;
    if (id !== undefined && id !== resourceId(document))
        issues.push({
            severity: "error",
            code: "RESOURCE_ID_MISMATCH",
            path: document.kind === "Client" ? "/spec/clientId" : "/spec/id",
            message: "Resource identifier does not match metadata.id",
        });
    issues.push(...configRuleIssues(document));
    return issues;
}

/**
 * Rules JSON Schema cannot express, for a document of its declared version:
 * one display entry per locale in a CredentialConfig from v4 on.
 */
function configRuleIssues(
    document: ConfigDocument,
): ConfigMigrationIssue[] {
    const display = (document.spec.config as { display?: unknown } | undefined)
        ?.display;
    if (
        document.kind !== "CredentialConfig" ||
        resolveConfigIdentity(serializeDocument(document)).version < 4 ||
        !Array.isArray(display)
    )
        return [];
    return findDuplicateDisplayLocales(display).map((duplicate) => ({
        severity: "error",
        code: "DISPLAY_LOCALE_DUPLICATE",
        path: `/spec/config/display/${duplicate.index}/locale`,
        message: duplicateDisplayLocaleMessage(duplicate),
        resource: { kind: document.kind, id: resourceId(document) },
    }));
}
