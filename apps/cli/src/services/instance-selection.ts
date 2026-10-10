import { readStringFlag } from "../options.js";
import type { CliConfig, ParsedArgs } from "../types.js";
import { getInstance } from "./cli-config.js";

export function resolveInstance(
    config: CliConfig,
    parsed: ParsedArgs,
): [string, CliConfig["instances"][string]] {
    const name =
        readStringFlag(parsed.flags, "instance") ?? config.defaultInstance;
    if (!name) {
        throw new Error(
            "No instance selected. Use --instance or add an instance first.",
        );
    }
    return [name, getInstance(config, name)];
}
