import { Command, Option } from "commander";
import type { CommandContext } from "../../../types.js";
import { loadCliState, parsedArgs, type SetExitCode } from "../../shared.js";
import { runPortabilityCommand } from "./action.js";

export function createPortabilityCommands(
    context: CommandContext,
    setExitCode: SetExitCode,
): Command[] {
    const remote = (name: "export" | "plan" | "import") => {
        const command = new Command(name)
            .description(
                name === "export"
                    ? "Export a tenant configuration bundle"
                    : `${name === "plan" ? "Plan" : "Apply"} a tenant configuration bundle`,
            )
            .option("--instance <name>", "select a configured instance")
            .option("--token <token>", "management API access token");
        if (name === "export") {
            command.option("--output <path>", "output bundle path");
        } else {
            command
                .argument(
                    "<bundle-or-folder>",
                    "bundle (.zip or .json) or tenant config folder; a folder is validated offline before it is sent",
                )
                .addOption(
                    new Option("--mode <mode>", "import mode")
                        .choices(["create", "upsert", "replace"])
                        .default("upsert"),
                );
            if (name === "import") {
                command
                    .option(
                        "--confirm-replace",
                        "confirm deletion semantics for replace mode",
                    )
                    .option(
                        "--plan <path>",
                        "saved JSON plan reviewed before applying",
                    )
                    .option(
                        "--plan-fingerprint <fingerprint>",
                        "fingerprint from the reviewed plan",
                    );
            }
        }
        if (name === "plan")
            command
                .addOption(
                    new Option("--format <text|json>", "plan output format")
                        .choices(["text", "json"])
                        .default(undefined, "json"),
                )
                .option(
                    "--diff",
                    "show a readable plan with redacted field changes (alias for --format text)",
                )
                .option("--output <path>", "save the plan for a later import");
        command.action(async (...args: any[]) => {
            const options = args.at(-2) as Record<string, string | boolean>;
            const positionals = name === "export" ? [] : [String(args[0])];
            const { config } = await loadCliState(context);
            setExitCode(
                await runPortabilityCommand(
                    name,
                    config,
                    parsedArgs("config", name, positionals, options),
                    context,
                ),
            );
        });
        return command;
    };

    const upgrade = new Command("upgrade")
        .description("Upgrade a local configuration file, folder, or bundle")
        .argument("<file-or-folder>")
        .option(
            "--output <path>",
            "write upgraded configuration to this separate path",
        )
        .option(
            "--check",
            "exit with status 1 if an upgrade is needed; never write output",
        )
        .option("--diff", "show changes with sensitive values redacted")
        .option("--dry-run", "report migrations without writing output")
        .action(async (file, options) => {
            const { config } = await loadCliState(context);
            setExitCode(
                await runPortabilityCommand(
                    "upgrade",
                    config,
                    parsedArgs("config", "upgrade", [file], options),
                    context,
                ),
            );
        });
    const operations = new Command("operations")
        .description(
            "List recent configuration operations or inspect one durable report",
        )
        .argument("[operation-id]")
        .option("--instance <name>", "select a configured instance")
        .option("--token <token>", "management API access token");
    const recover = new Command("recover")
        .description(
            "Acknowledge an interrupted config operation after stopping its worker",
        )
        .argument("<operation-id>")
        .option(
            "--confirm-worker-stopped",
            "confirm the original worker has been stopped",
        )
        .option("--instance <name>", "select a configured instance")
        .option("--token <token>", "management API access token");
    for (const command of [operations, recover])
        command.action(async (id, options) => {
            const { config } = await loadCliState(context);
            setExitCode(
                await runPortabilityCommand(
                    command.name() as "operations" | "recover",
                    config,
                    parsedArgs(
                        "config",
                        command.name(),
                        id ? [id] : [],
                        options,
                    ),
                    context,
                ),
            );
        });
    return [
        remote("export"),
        remote("plan"),
        remote("import"),
        upgrade,
        operations,
        recover,
    ];
}
