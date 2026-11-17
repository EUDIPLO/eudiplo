import { runDoctor } from "../../services/diagnostics.js";
import { resolveInstance } from "../../services/instance-selection.js";
import { redactUrl } from "../../services/url.js";
import type { CliConfig, CommandContext, ParsedArgs } from "../../types.js";

export async function runStatusCommand(
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const [instanceName, instance] = resolveInstance(config, parsed);
    const checks = await runDoctor(instance, context, []);
    const health = checks.find((check) => check.name === "health endpoint");
    context.stdout.write(
        `${instanceName} (${instance.target}) ${redactUrl(instance.url)}\n`,
    );
    if (health) {
        context.stdout.write(
            `${health.status.toUpperCase()} ${health.message}\n`,
        );
    }
    return health?.status === "fail" ? 1 : 0;
}
