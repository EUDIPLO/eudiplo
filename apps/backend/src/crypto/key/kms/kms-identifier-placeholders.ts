import type { ValidationIssue } from "../../../shared/common/zod/zod-schema.util.js";
import { HOLDS_ENV_PLACEHOLDER } from "./kms-tenant-restrictions.js";

/** The variables `value` names, in both placeholder forms. */
const placeholderNames = (value: string) => [
    ...new Set(
        [...value.matchAll(/\$\{([A-Z0-9_]+)[:}]/g)].map((match) => match[1]),
    ),
];

/**
 * `${VAR}` placeholders in the identifiers of a tenant KMS configuration:
 * `defaultProvider` and the `id` of a provider.
 *
 * The API returns identifiers as they are and never treats them as secrets,
 * so a resolved one would show the variable's value to everyone who may read
 * the tenant's providers. No tenant `kms.json` may hold one, whoever wrote it
 * and whatever `KMS_TENANT_VARIABLES` lists.
 *
 * @param config the configuration as stored, before placeholders are resolved.
 */
export function findKmsIdentifierPlaceholderIssues(
    config: unknown,
): ValidationIssue[] {
    if (!config || typeof config !== "object") return [];
    const { defaultProvider, providers } = config as {
        defaultProvider?: unknown;
        providers?: unknown;
    };
    const identifiers: [Array<string | number>, unknown][] = [
        [["defaultProvider"], defaultProvider],
        ...(Array.isArray(providers) ? providers : []).map(
            (provider, index): [Array<string | number>, unknown] => [
                ["providers", index, "id"],
                (provider as { id?: unknown } | null)?.id,
            ],
        ),
    ];
    return identifiers.flatMap(([path, value]) =>
        typeof value === "string" && HOLDS_ENV_PLACEHOLDER.test(value)
            ? [
                  {
                      path,
                      message: `${path.join(".")} names ${placeholderNames(
                          value,
                      )
                          .map((name) => `\${${name}}`)
                          .join(
                              ", ",
                          )}: the identifiers of a tenant kms.json cannot hold a placeholder`,
                      code: "refused_environment_variable",
                  },
              ]
            : [],
    );
}
