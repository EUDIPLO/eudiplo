import { Command, Option } from "commander";
import type { CommandContext } from "../../../types.js";
import { loadCliState, parsedArgs, type SetExitCode } from "../../shared.js";
import { runValidate } from "./action.js";

export function createValidateCommand(
    context: CommandContext,
    setExitCode: SetExitCode,
): Command {
    return new Command("validate")
        .description("Validate CLI or tenant config-import files")
        .argument(
            "[scope]",
            '"tenant" for one tenant folder or "tenants" for a folder of tenant folders; omit it to validate the CLI config file',
        )
        .argument("[path]", "the folder to validate (required with a scope)")
        .addOption(
            new Option("--format <text|json>", "tenant report format")
                .choices(["text", "json"])
                .default("text"),
        )
        .action(async (scope, path, options) => {
            const state = await loadCliState(context);
            const positionals = [scope, path].filter(
                (value): value is string => typeof value === "string",
            );
            setExitCode(
                await runValidate(
                    state.configPath,
                    state.config,
                    parsedArgs("config", "validate", positionals, options),
                    context,
                ),
            );
        });
}
