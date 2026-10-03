import { resolveConfigPath } from "../../services/cli-config.js";
import type { CliConfig, CommandContext, InstanceConfig } from "../../types.js";

export function runConfigPath(context: CommandContext): number {
    context.stdout.write(`${resolveConfigPath(context.env)}\n`);
    return 0;
}

export function runConfigShow(
    configPath: string,
    config: CliConfig,
    json: boolean,
    context: CommandContext,
): number {
    if (json) {
        context.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
        return 0;
    }

    context.stdout.write(`Config: ${configPath}\n`);
    context.stdout.write(
        `Default instance: ${config.defaultInstance ?? "none"}\n`,
    );
    const instances = Object.entries(config.instances).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    if (instances.length === 0) {
        context.stdout.write("Instances: none\n");
        return 0;
    }

    context.stdout.write("Instances:\n");
    for (const [name, instance] of instances) {
        const defaultLabel =
            name === config.defaultInstance ? " (default)" : "";
        context.stdout.write(`- ${name}${defaultLabel}\n`);
        writeInstance(instance, context);
    }
    return 0;
}

function writeInstance(
    instance: InstanceConfig,
    context: CommandContext,
): void {
    for (const [key, value] of Object.entries(instance)) {
        if (value !== undefined) {
            context.stdout.write(
                `  ${key}: ${Array.isArray(value) ? value.join(", ") : value}\n`,
            );
        }
    }
}
