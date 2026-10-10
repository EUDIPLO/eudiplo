import { basename, isAbsolute, join } from "node:path";
import { readStringFlag } from "../../../options.js";
import { redactUrl } from "../../../services/cli-config.js";
import type { CliConfig, CommandContext, ParsedArgs } from "../../../types.js";
import { buildJsonReport, formatTextReport } from "./report.js";
import { loadTenantConfigSchemas } from "./schemas.js";
import { validateTenantDirectory, validateTenantsRoot } from "./validator.js";

export async function runValidate(
    configPath: string,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const tenantTarget = parsed.positionals[0];
    if (tenantTarget === "tenant" || tenantTarget === "tenants") {
        return validateTenantConfig(tenantTarget, parsed, context);
    }
    if (tenantTarget) {
        throw new Error("Usage: eudiplo config validate");
    }

    const instanceNames = Object.keys(config.instances);
    context.stdout.write(`Config is valid: ${configPath}\n`);
    context.stdout.write(`Instances: ${instanceNames.length}\n`);
    if (config.defaultInstance) {
        context.stdout.write(`Default instance: ${config.defaultInstance}\n`);
    }
    for (const name of instanceNames) {
        const instance = config.instances[name];
        context.stdout.write(
            `- ${name}: ${instance.target} ${redactUrl(instance.url)}\n`,
        );
    }
    return 0;
}

export async function validateTenantConfig(
    scope: "tenant" | "tenants",
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const pathArg = parsed.positionals[1];
    if (!pathArg) {
        throw new Error(
            `Usage: eudiplo config validate ${scope} <path> [--format text|json]`,
        );
    }

    const format = readStringFlag(parsed.flags, "format") ?? "text";
    if (format !== "text" && format !== "json") {
        throw new Error("Unsupported --format value. Use text or json.");
    }

    const rootPath = isAbsolute(pathArg) ? pathArg : join(context.cwd, pathArg);
    const schemas = await loadTenantConfigSchemas();
    const results =
        scope === "tenant"
            ? [
                  await validateTenantDirectory(
                      rootPath,
                      basename(rootPath),
                      schemas,
                      context.env,
                  ),
              ]
            : await validateTenantsRoot(rootPath, schemas, context.env);

    context.stdout.write(
        format === "json"
            ? `${JSON.stringify(buildJsonReport(results), null, 2)}\n`
            : formatTextReport(scope, rootPath, results),
    );
    return results.some((result) => !result.valid) ? 1 : 0;
}
